"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bolt_1 = require("@slack/bolt");
const env_1 = require("./env");
const store_1 = require("./store");
const openai_1 = __importDefault(require("openai"));
const client_1 = require("@modelcontextprotocol/sdk/client");
const stdio_1 = require("@modelcontextprotocol/sdk/client/stdio");
const parseSinceToMinutes = (text, defaultMinutes = 120) => {
    // Accepts: since 30m | 2h | 1w (also “mins/min/minute/minutes”, “hr/hrs/hour/hours”, “wk/wks/week/weeks”)
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
const initSlack = (app) => {
    const receiver = new bolt_1.ExpressReceiver({
        signingSecret: env_1.env.SLACK_SIGNING_SECRET,
        endpoints: { events: "/slack/events", interactions: "/slack/interactive" }
    });
    const slack = new bolt_1.App({
        token: env_1.env.SLACK_BOT_TOKEN,
        receiver
    });
    const openai = new openai_1.default({ apiKey: env_1.env.OPENAI_API_KEY });
    // Minimal MCP client manager for GitLab and Sentry
    const mcpClients = {};
    const ensureMcpClient = async (key) => {
        if (mcpClients[key])
            return mcpClients[key];
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
        const transport = new stdio_1.StdioClientTransport({
            command,
            args,
            env: { ...process.env, ...extraEnv },
            stderr: "inherit"
        });
        const client = new client_1.Client({ name: `oncallbot-${key}-client`, version: "0.1.0" });
        await client.connect(transport);
        mcpClients[key] = client;
        return client;
    };
    slack.command("/oncall", async ({ ack, respond, command }) => {
        await ack();
        const text = (command.text || "").trim().toLowerCase();
        const minutes = parseSinceToMinutes(text, 120);
        const data = (0, store_1.getEvents)(minutes);
        const prompt = [
            "You are an SRE copilot. Summarize the last",
            `${minutes} minutes of Sentry alerts and GitLab activity.`,
            "Group by project; call out regressions, repeating errors, failing pipelines, and risky MRs.",
            "Return a concise, Slack-friendly report with bullets, emojis, and include URLs when present.",
            `Data JSON:\n${JSON.stringify(data, null, 2)}`
        ].join(" ");
        const completion = await openai.chat.completions.create({
            model: "gpt-4.1-mini",
            temperature: 0.2,
            messages: [{ role: "user", content: prompt }]
        });
        await respond({
            response_type: "ephemeral", // or "in_channel" if you want it visible
            text: completion.choices[0]?.message?.content ?? "No summary."
        });
    });
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
                    project: args.project,
                    org: args.org,
                    query: args.query,
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
    // /oncall-report project=<gitlabProject> sentry=<sentryProject> [org=<org>] [channel=<name>] [keywords=...] [limit=20]
    slack.command("/oncall-report", async ({ ack, respond, command }) => {
        await ack();
        const text = (command.text || "").trim();
        const args = {};
        for (const part of text.split(/\s+/).filter(Boolean)) {
            const i = part.indexOf("=");
            if (i > 0)
                args[part.slice(0, i)] = part.slice(i + 1);
        }
        const glProject = args.project;
        const seProject = args.sentry || args.sentryProject;
        const org = args.org;
        const channel = args.channel;
        const keywords = args.keywords || "incident OR error OR outage";
        const limit = args.limit ? Number(args.limit) : 20;
        try {
            // Fetch GitLab MRs
            let gitlabText = "";
            if (glProject) {
                const gl = await ensureMcpClient("gitlab");
                const glRes = await gl.callTool({ name: "gitlab_list_mrs", arguments: { projectId: glProject, state: "opened" } }, undefined, { timeout: 20000 });
                const glContent = glRes.content || [];
                gitlabText = (Array.isArray(glContent) ? glContent : []).map((c) => (c?.type === "text" ? c.text : "")).join("\n");
                if (gitlabText.length > 8000)
                    gitlabText = gitlabText.slice(0, 8000);
            }
            // Fetch Sentry issues
            let sentryText = "";
            if (seProject || org) {
                const se = await ensureMcpClient("sentry");
                const seRes = await se.callTool({
                    name: "sentry_list_issues",
                    arguments: { project: seProject || "", org, limit, query: "is:unresolved" }
                }, undefined, { timeout: 20000 });
                const seContent = seRes.content || [];
                sentryText = (Array.isArray(seContent) ? seContent : []).map((c) => (c?.type === "text" ? c.text : "")).join("\n");
                if (sentryText.length > 8000)
                    sentryText = sentryText.slice(0, 8000);
            }
            // Search Slack channel (optional)
            let slackSearchText = "";
            if (channel) {
                const sk = await ensureMcpClient("slack");
                const skRes = await sk.callTool({ name: "slack_search_channel", arguments: { channel, keywords } }, undefined, { timeout: 20000 });
                const skContent = skRes.content || [];
                slackSearchText = (Array.isArray(skContent) ? skContent : []).map((c) => (c?.type === "text" ? c.text : "")).join("\n");
                if (slackSearchText.length > 8000)
                    slackSearchText = slackSearchText.slice(0, 8000);
            }
            // Compose report prompt
            const reportPrompt = [
                "You are an SRE copilot. Create a concise on-call report.",
                "Summarize unresolved Sentry issues, current GitLab open MRs, and notable Sentry, GitLab, and Slack messages.",
                "Return Slack-friendly bullets, emojis, risks, and include URLs when present.",
                "GitLab MRs JSON:",
                gitlabText || "[]",
                "\nSentry Issues JSON:",
                sentryText || "[]",
                "\nSlack Messages JSON:",
                slackSearchText || "[]"
            ].join("\n");
            const completion = await openai.chat.completions.create({
                model: "gpt-4.1-mini",
                temperature: 0.2,
                messages: [{ role: "user", content: reportPrompt }]
            });
            await respond({ response_type: "ephemeral", text: completion.choices[0]?.message?.content ?? "No summary." });
        }
        catch (err) {
            await respond({ response_type: "ephemeral", text: `Error: ${err?.message || String(err)}` });
        }
    });
    // Mount Bolt’s Express app onto our server
    app.use(receiver.app);
};
exports.default = initSlack;
