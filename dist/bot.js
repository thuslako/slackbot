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
    const dataCache = {};
    // Check if cache is valid (not older than 1 day and not older than requested time range)
    const isCacheValid = (cacheKey, requestedTimeRange) => {
        const entry = dataCache[cacheKey];
        if (!entry)
            return false;
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000; // 24 hours in ms
        // Cache is invalid if older than 1 day
        if (now - entry.timestamp > oneDay) {
            console.log(`[cache] ${cacheKey} expired (older than 1 day)`);
            return false;
        }
        // Cache is invalid if requested time range is more recent than cached time range
        const requestedMs = getTimeRangeMs(requestedTimeRange);
        const cachedMs = getTimeRangeMs(entry.timeRange);
        if (requestedMs < cachedMs) {
            console.log(`[cache] ${cacheKey} invalid (requested ${requestedTimeRange} is more recent than cached ${entry.timeRange})`);
            return false;
        }
        console.log(`[cache] ${cacheKey} valid (cached ${entry.timeRange}, requested ${requestedTimeRange})`);
        return true;
    };
    const getTimeRangeMs = (timeRange) => {
        const match = timeRange.match(/^(\d+)([mhdw])$/);
        if (!match)
            return 24 * 60 * 60 * 1000; // Default to 1 day
        const value = parseInt(match[1], 10);
        const unit = match[2];
        switch (unit) {
            case 'm': return value * 60 * 1000;
            case 'h': return value * 60 * 60 * 1000;
            case 'd': return value * 24 * 60 * 60 * 1000;
            case 'w': return value * 7 * 24 * 60 * 60 * 1000;
            default: return 24 * 60 * 60 * 1000;
        }
    };
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
            // Get Sentry issues for the time range (with caching)
            const cacheKey = `sentry-${env_1.env.SENTRY_ORG}-${timeRange}`;
            let sentryIssues = {};
            if (isCacheValid(cacheKey, timeRange)) {
                sentryIssues = dataCache[cacheKey].data;
                console.log(`[cache] using cached Sentry data for ${timeRange}`);
            }
            else {
                console.log(`[cache] cache miss or invalid for ${cacheKey}, making fresh API call`);
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
                try {
                    sentryIssues = JSON.parse(sentryText);
                    if (typeof sentryIssues !== 'object' || Array.isArray(sentryIssues)) {
                        console.error(`[bot] sentry response is not an object: ${typeof sentryIssues}`);
                        sentryIssues = {};
                    }
                    else {
                        // Cache the successful result
                        dataCache[cacheKey] = {
                            data: sentryIssues,
                            timestamp: Date.now(),
                            timeRange: timeRange
                        };
                        console.log(`[cache] stored Sentry data for ${timeRange} (cached ${Object.keys(sentryIssues).length} projects)`);
                    }
                }
                catch (e) {
                    console.error(`[bot] failed to parse sentry response as JSON: ${e}`);
                    console.error(`[bot] sentry response text: ${sentryText}`);
                    sentryIssues = {};
                }
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
            // Compose detailed report prompt with token limit safeguards
            const basePrompt = [
                "You are an SRE copilot called depthCart 💣. Create a detailed on-call report with the following EXACT structure:",
                "",
                "## Critical Issues Requiring Attention",
                "",
                "For each critical issue, use this EXACT format:",
                "### 1. [Issue Title and Link]",
                "- **GitLab Ticket/MR:** [Link or 'None found']",
                "- **Latest GitLab Comments:** [Comments or 'None']",
                "- **Slack Tracking Status:** [Status or 'Not tracked']",
                "- **Severity & Impact:**",
                "  - **Priority:** [High/Medium/Low]",
                "  - **Impact:** [Brief description of impact]",
                "",
                "IMPORTANT: Do NOT add extra emojis, separators (---), or modify the structure. Follow the exact format above.",
                "",
                "## Recent Activity Summary",
                `- Total issues found in ${timeRange} time range (filtered from 14d Sentry data)`,
                "- Issues with GitLab correlation",
                "- Issues being tracked in Slack",
                "- Overall system health assessment",
                "",
                "Use markdown, emojis, bullets, and include all relevant URLs. Be concise but comprehensive. DO NOT DEVIATE FROM THE SPECIFIED FORMAT."
            ].join("\n");
            // Estimate tokens and truncate if needed (rough estimation: 1 token ≈ 4 characters)
            const MAX_TOKENS = 120000;
            const sentryJson = JSON.stringify(sentryIssues, null, 2);
            const sentryTextTokens = Math.ceil(sentryJson.length / 4);
            const correlationsTextTokens = Math.ceil(JSON.stringify(issueCorrelations, null, 2).length / 4);
            const basePromptTokens = Math.ceil(basePrompt.length / 4);
            let finalSentryJson = sentryJson;
            let finalCorrelationsText = JSON.stringify(issueCorrelations, null, 2);
            if (sentryTextTokens + correlationsTextTokens + basePromptTokens > MAX_TOKENS) {
                console.log(`[token-limit] Total estimated tokens: ${sentryTextTokens + correlationsTextTokens + basePromptTokens}, limiting...`);
                // If Sentry data is too large, truncate it
                if (sentryTextTokens > 50000) {
                    const maxSentryLength = 50000 * 4; // 50k tokens worth of characters
                    finalSentryJson = sentryJson.slice(0, maxSentryLength) + "\n... (truncated for token limit)";
                    console.log(`[token-limit] Truncated Sentry data from ${sentryJson.length} to ${finalSentryJson.length} characters`);
                }
                // If correlations are too large, truncate the JSON
                if (correlationsTextTokens > 30000) {
                    const maxCorrelationsLength = 30000 * 4; // 30k tokens worth of characters
                    finalCorrelationsText = JSON.stringify(issueCorrelations.slice(0, 10), null, 2) + "\n... (showing first 10 correlations only)";
                    console.log(`[token-limit] Truncated correlations from ${issueCorrelations.length} to 10 items`);
                }
            }
            const reportPrompt = [
                basePrompt,
                "",
                "Sentry Issues JSON (filtered to requested time range):",
                finalSentryJson,
                "",
                "Issue Correlations JSON (matches between Sentry issues and GitLab tickets):",
                finalCorrelationsText,
                "",
                "INSTRUCTIONS:",
                "- Analyze ALL Sentry Issues in the JSON to identify critical issues (focus on unresolved issues with recent activity)",
                "- Use the Issue Correlations JSON to find related GitLab tickets, comments, and Slack tracking",
                "- For issues WITHOUT correlations, use 'None found', 'None', and 'Not tracked'",
                "- Include 3-5 most critical issues in the report",
                "- Determine priority based on: frequency, recency, error type, and potential impact",
                "- Format EXACTLY as specified above - no extra emojis, separators, or modifications",
                "- Keep each issue description to 2-3 sentences maximum"
            ].join("\n");
            // Fallback for no Sentry data
            if (!sentryIssues || Object.keys(sentryIssues).length === 0) {
                await respond({
                    response_type: "ephemeral",
                    text: `## Critical Issues Requiring Attention\n\n✅ No critical Sentry issues found in the ${timeRange} time range.\n\n## Recent Activity Summary\n- Total issues found: 0\n- Issues with GitLab correlation: 0\n- Issues being tracked in Slack: 0\n- **Overall system health assessment:** All systems appear stable with no critical alerts.`
                });
                return;
            }
            const completion = await openai.chat.completions.create({
                model: "gpt-4.1",
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
    // /clear-cache - Clear all cached data
    slack.command("/clear-cache", async ({ ack, respond, command }) => {
        await ack();
        const cacheSize = Object.keys(dataCache).length;
        Object.keys(dataCache).forEach(key => delete dataCache[key]); // Clear the cache
        console.log(`[cache] cleared ${cacheSize} cached entries`);
        await respond({ response_type: "ephemeral", text: `✅ Cleared ${cacheSize} cached entries` });
    });
    // Mount Bolt’s Express app onto our server
    app.use(receiver.app);
};
exports.default = initSlack;
