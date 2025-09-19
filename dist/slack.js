"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bolt_1 = require("@slack/bolt");
const env_1 = require("./env");
const store_1 = require("./store");
const openai_1 = __importDefault(require("openai"));
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
        const im = await slack.client.conversations.open({ users: command.user_id });
        const dmChannel = im.channel?.id;
        await slack.client.chat.postMessage({
            channel: dmChannel,
            text: completion.choices[0]?.message?.content ?? "No summary."
        });
    });
    // Mount Bolt’s Express app onto our server
    app.use(receiver.app);
};
exports.default = initSlack;
