"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bolt_1 = require("@slack/bolt");
const env_1 = require("./env");
const openai_1 = __importDefault(require("openai"));
const client_1 = require("@modelcontextprotocol/sdk/client");
const stdio_js_1 = require("@modelcontextprotocol/sdk/client/stdio.js");
const parseSinceToMinutes = (text, defaultMinutes = 120) => {
    // Accepts: since 30m | 2h | 1w (also "mins/min/minute/minutes", "hr/hrs/hour/hours", "wk/wks/week/weeks")
    // Case-insensitive, ignores extra spaces. First match wins.
    const m = text.toLowerCase().match(/since\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|w|wk|wks|week|weeks)\b/);
    if (!m) {
        // special case: "since today"
        if (/since\s+today\b/i.test(text)) {
            const now = new Date();
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
            return Math.max(1, Math.floor((now.getTime() - startOfDay.getTime()) / 60000));
        }
        return defaultMinutes;
    }
    const value = parseInt(m[1], 10);
    const unit = m[2];
    if (Number.isNaN(value) || value < 0)
        return defaultMinutes;
    // Convert to minutes
    const toMinutes = (u) => {
        if (/(^m$|^min$|^mins$|^minute$|^minutes$)/.test(u))
            return value;
        if (/(^h$|^hr$|^hrs$|^hour$|^hours$)/.test(u))
            return value * 60;
        if (/(^w$|^wk$|^wks$|^week$|^weeks$)/.test(u))
            return value * 7 * 24 * 60;
        return value; // fallback (shouldn’t hit)
    };
    return toMinutes(unit);
};
const getCutoffTime = (timeRange) => {
    const now = Date.now();
    const match = timeRange.match(/^(\d+)([mhdw])$/);
    if (!match) {
        // Default to 1 week if invalid format
        return now - (7 * 24 * 60 * 60 * 1000);
    }
    const value = parseInt(match[1], 10);
    const unit = match[2];
    let milliseconds = 0;
    switch (unit) {
        case 'm':
            milliseconds = value * 60 * 1000;
            break;
        case 'h':
            milliseconds = value * 60 * 60 * 1000;
            break;
        case 'd':
            milliseconds = value * 24 * 60 * 60 * 1000;
            break;
        case 'w':
            milliseconds = value * 7 * 24 * 60 * 60 * 1000;
            break;
        default:
            milliseconds = 7 * 24 * 60 * 60 * 1000; // default to 1 week
    }
    return now - milliseconds;
};
const initSlack = (app) => {
    const receiver = new bolt_1.ExpressReceiver({
        signingSecret: env_1.env.SLACK_SIGNING_SECRET,
        endpoints: { events: "/slack/events", interactions: "/slack/interactive" }
    });
    const slack = new bolt_1.App({
        token: env_1.env.SLACK_BOT_TOKEN,
        receiver,
        logLevel: bolt_1.LogLevel.DEBUG
    });
    const openai = new openai_1.default({ apiKey: env_1.env.OPENAI_API_KEY });
    // Minimal MCP client manager for GitLab and Sentry
    const mcpClients = {};
    const ensureMcpClient = async (key) => {
        if (mcpClients[key])
            return mcpClients[key];
        console.log(`[mcp] starting ${key} client`);
        const command = process.execPath; // node executable
        const script = key === "gitlab"
            ? "dist/mcp/gitlab.js"
            : key === "sentry"
                ? "dist/mcp/sentry.js"
                : "dist/mcp/slack.js";
        const args = [script];
        const extraEnv = key === "gitlab"
            ? {
                GITLAB_TOKEN: String(process.env.GITLAB_TOKEN || ""),
                GITLAB_HOST: String(process.env.GITLAB_HOST || "https://gitlab.com")
            }
            : key === "sentry" ? {
                SENTRY_TOKEN: String(process.env.SENTRY_TOKEN || ""),
                SENTRY_HOST: String(process.env.SENTRY_HOST || "https://sentry.io"),
                SENTRY_ORG: String(process.env.SENTRY_ORG || "")
            } : {
                SLACK_BOT_TOKEN: String(process.env.SLACK_BOT_TOKEN || "")
            };
        console.log(`[mcp] spawning ${key}: ${command} ${args.join(' ')}`);
        const transport = new stdio_js_1.StdioClientTransport({
            command,
            args,
            env: { ...process.env, ...extraEnv },
            stderr: "pipe" // Change to "pipe" to log stderr
        });
        transport.stderr?.on("data", (data) => {
            console.error(`[mcp ${key} stderr] ${data.toString().trim()}`);
        });
        const client = new client_1.Client({ name: `oncallbot-${key}-client`, version: "0.1.0" });
        await client.connect(transport);
        console.log(`[mcp] connected ${key}`);
        mcpClients[key] = client;
        return client;
    };
    // /sentry-issues project=<slug> [org=<org>] [query=...] [limit=20]
    slack.command("/sentry-issues", async ({ ack, respond, command }) => {
        await ack();
        const text = (command.text || "").trim();
        const args = {};
        for (const part of text.split(/\s+/).filter(Boolean)) {
            const idx = part.indexOf("=");
            if (idx > 0)
                args[part.slice(0, idx)] = part.slice(idx + 1);
            else if (!args.project)
                args.project = part;
        }
        if (!args.project) {
            await respond({ response_type: "ephemeral", text: "Usage: /sentry-issues project=<slug> [org=<org>] [query=...] [limit=20]" });
            return;
        }
        try {
            const client = await ensureMcpClient("sentry");
            const result = await client.callTool({
                name: "sentry_list_issues",
                arguments: {
                    project: args.project || env_1.env.SENTRY_PROJECTS,
                    org: args.org || env_1.env.SENTRY_ORG,
                    query: args.query || "",
                    limit: args.limit ? Number(args.limit) : undefined
                }
            }, undefined, { timeout: 20000 });
            const contentAny = result.content || [];
            const textOut = (Array.isArray(contentAny) ? contentAny : [])
                .map((c) => (c?.type === "text" ? c.text : ""))
                .join("\n");
            await respond({ response_type: "ephemeral", text: textOut.slice(0, 3500) || "No results." });
        }
        catch (err) {
            await respond({ response_type: "ephemeral", text: `Error: ${err?.message || String(err)}` });
        }
    });
    // /gitlab-mrs <projectIdOrPath> [state]
    slack.command("/gitlab-mrs", async ({ ack, respond, command }) => {
        await ack();
        const parts = (command.text || "").trim().split(/\s+/).filter(Boolean);
        const projectId = parts[0];
        const state = parts[1];
        if (!projectId) {
            await respond({ response_type: "ephemeral", text: "Usage: /gitlab-mrs <projectIdOrPath> [state]" });
            return;
        }
        try {
            const client = await ensureMcpClient("gitlab");
            const result = await client.callTool({
                name: "gitlab_list_mrs",
                arguments: { projectId, state }
            }, undefined, { timeout: 20000 });
            const contentAny = result.content || [];
            const textOut = (Array.isArray(contentAny) ? contentAny : [])
                .map((c) => (c?.type === "text" ? c.text : ""))
                .join("\n");
            await respond({ response_type: "ephemeral", text: textOut.slice(0, 3500) || "No results." });
        }
        catch (err) {
            await respond({ response_type: "ephemeral", text: `Error: ${err?.message || String(err)}` });
        }
    });
    // /oncall-report <timeRange>
    slack.command("/oncall-report", async ({ ack, respond, command }) => {
        await ack();
        const text = (command.text || "").trim();
        console.log(`/oncall-report invoked: "${text}" by ${command.user_id}`);
        const timeRange = text || "1w"; // e.g., 30m, 2h, 1d
        console.log(`/oncall-report parsed: timeRange=${timeRange}`);
        try {
            // Time window params
            const statsPeriod = /^(\d+)(m|h|d|w)$/.test(timeRange) ? timeRange : "7d";
            // Get Sentry issues for the time range
            console.log(`[mcp] calling sentry_list_issues_time_range with org=${env_1.env.SENTRY_ORG}, statsPeriod=${statsPeriod}`);
            const t0 = Date.now();
            const se = await ensureMcpClient("sentry");
            const seRes = await se.callTool({
                name: "sentry_list_issues_time_range",
                arguments: { org: env_1.env.SENTRY_ORG, statsPeriod, limitPerProject: 50 }
            }, undefined, { timeout: 30000 });
            const seContent = seRes.content || [];
            const sentryText = (Array.isArray(seContent) ? seContent : []).map((c) => (c?.type === "text" ? c.text : "")).join("\n");
            console.log(`[mcp] sentry_list_issues_time_range done in ${Date.now() - t0}ms, response bytes=${JSON.stringify(seRes).length}, parsed length=${sentryText.length}`);
            // Handle case where sentryText is not valid JSON or is an error message
            let sentryIssues = {};
            try {
                sentryIssues = JSON.parse(sentryText);
                if (typeof sentryIssues !== 'object' || Array.isArray(sentryIssues)) {
                    console.error(`[bot] sentry response is not an object: ${typeof sentryIssues}`);
                    sentryIssues = {};
                }
            }
            catch (e) {
                console.error(`[bot] failed to parse sentry response as JSON: ${e}`);
                console.error(`[bot] sentry response text: ${sentryText}`);
                sentryIssues = {};
            }
            // Filter Sentry issues to the requested time range
            if (sentryIssues && Object.keys(sentryIssues).length > 0) {
                const cutoffTime = getCutoffTime(timeRange);
                const filteredIssues = {};
                for (const [projectSlug, issues] of Object.entries(sentryIssues)) {
                    const filtered = issues.filter(issue => {
                        const issueTime = new Date(issue.lastSeen || issue.firstSeen || 0).getTime();
                        return issueTime >= cutoffTime;
                    });
                    if (filtered.length > 0) {
                        filteredIssues[projectSlug] = filtered;
                    }
                }
                sentryIssues = filteredIssues;
                console.log(`[bot] filtered Sentry issues: ${Object.keys(sentryIssues).length} projects, ${Object.values(sentryIssues).flat().length} total issues within ${timeRange}`);
            }
            // For each Sentry issue, find related GitLab tickets and track in Slack
            let issueCorrelations = [];
            try {
                issueCorrelations = [];
                if (!sentryIssues || Object.keys(sentryIssues).length === 0) {
                    console.log(`[correlation] no Sentry issues found, skipping correlation`);
                }
                else {
                    for (const [projectSlug, issues] of Object.entries(sentryIssues)) {
                        for (const issue of issues) {
                            console.log(`[correlation] processing Sentry issue: ${issue.title} (${issue.id})`);
                            // Find related GitLab ticket
                            const gl = await ensureMcpClient("gitlab");
                            const glRes = await gl.callTool({
                                name: "gitlab_find_related_ticket",
                                arguments: { issueTitle: issue.title, projectId: process.env.GITLAB_PROJECT }
                            }, undefined, { timeout: 15000 });
                            const glContent = glRes.content || [];
                            const gitlabTicket = (Array.isArray(glContent) ? glContent : []).find((c) => c?.type === "text" && c.text);
                            if (gitlabTicket) {
                                console.log(`[correlation] found GitLab ticket: ${gitlabTicket}`);
                                // Get GitLab ticket comments
                                const glCommentsRes = await gl.callTool({
                                    name: "gitlab_get_ticket_comments",
                                    arguments: { ticketId: gitlabTicket.id, ticketType: gitlabTicket.type }
                                }, undefined, { timeout: 15000 });
                                const glCommentsContent = glCommentsRes.content || [];
                                const comments = (Array.isArray(glCommentsContent) ? glCommentsContent : []).map((c) => (c?.type === "text" ? c.text : "")).join("\n");
                                // Track in Slack
                                const sk = await ensureMcpClient("slack");
                                const skRes = await sk.callTool({
                                    name: "slack_track_ticket",
                                    arguments: {
                                        ticketId: gitlabTicket.id,
                                        ticketType: gitlabTicket.type,
                                        issueTitle: issue.title,
                                        channel: "#incidents"
                                    }
                                }, undefined, { timeout: 10000 });
                                const skContent = skRes.content || [];
                                const trackingResult = (Array.isArray(skContent) ? skContent : []).map((c) => (c?.type === "text" ? c.text : "")).join("\n");
                                issueCorrelations.push({
                                    sentryIssue: issue,
                                    gitlabTicket: gitlabTicket,
                                    comments: comments,
                                    slackTracking: trackingResult
                                });
                            }
                            else {
                                console.log(`[correlation] no GitLab ticket found for: ${issue.title}`);
                            }
                        }
                    }
                }
                console.log(`[correlation] processed ${issueCorrelations.length} issue correlations`);
            }
            catch (err) {
                console.error(`[correlation] error: ${err}`);
            }
            // Compose detailed report prompt
            const reportPrompt = [
                "You are an SRE copilot called depthCart 💣. Create a detailed on-call report with the following structure:",
                "",
                "## Critical Issues Requiring Attention",
                "- For each critical Sentry issue, include:",
                "  - Issue title and URL",
                "  - Related GitLab ticket/MR if found",
                "  - Latest comments from GitLab",
                "  - Slack tracking status",
                "  - Severity and impact assessment",
                "",
                "## Recent Activity Summary",
                `- Total issues found in ${timeRange} time range (filtered from 14d Sentry data)`,
                "- Issues with GitLab correlation",
                "- Issues being tracked in Slack",
                "- Overall system health assessment",
                "",
                "Use markdown, emojis, bullets, and include all relevant URLs. Be concise but comprehensive.",
                "",
                "Sentry Issues JSON (filtered to requested time range):",
                sentryText,
                "",
                "Issue Correlations JSON:",
                JSON.stringify(issueCorrelations, null, 2)
            ].join("\n");
            const completion = await openai.chat.completions.create({
                model: "gpt-4.1-mini",
                temperature: 0.2,
                messages: [{ role: "user", content: reportPrompt }]
            });
            await respond({ response_type: "ephemeral", text: completion.choices[0]?.message?.content ?? "No summary generated." });
        }
        catch (err) {
            console.error(`[oncall-report] error: ${err}`);
            await respond({ response_type: "ephemeral", text: `Error: ${err?.message || String(err)}` });
        }
    });
    // Mount Bolt’s Express app onto our server
    app.use(receiver.app);
};
exports.default = initSlack;
