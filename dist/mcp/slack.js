"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_1 = require("@modelcontextprotocol/sdk/server/mcp");
const stdio_1 = require("@modelcontextprotocol/sdk/server/stdio");
const web_api_1 = require("@slack/web-api");
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
if (!SLACK_BOT_TOKEN) {
    // Allow process to start; tool calls will error if token missing
}
const slack = new web_api_1.WebClient(SLACK_BOT_TOKEN);
const server = new mcp_1.McpServer({ name: "slack-mcp", version: "0.1.0" });
server.tool("slack_list_channels", "List public channels. Args: { limit? }", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const limit = args.limit ? Number(args.limit) : 50;
    const res = await slack.conversations.list({ limit });
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(res.channels || [], null, 2)
            }
        ]
    };
});
server.tool("slack_find_channel", "Find channel by name. Args: { name }", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const name = String(args.name || "");
    if (!name)
        return { content: [{ type: "text", text: "Missing name" }] };
    const res = await slack.conversations.list({ limit: 1000 });
    const ch = (res.channels || []).find((c) => c.name === name || c.name_normalized === name);
    return { content: [{ type: "text", text: JSON.stringify(ch || null, null, 2) }] };
});
server.tool("slack_post_message", "Post a message. Args: { channel, text }", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const channel = String(args.channel || "");
    const text = String(args.text || "");
    if (!channel || !text)
        return { content: [{ type: "text", text: "Missing channel or text" }] };
    const res = await slack.chat.postMessage({ channel, text });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
});
server.tool("slack_search", "Search workspace messages. Args: { query, count? }", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const query = String(args.query || "");
    const count = args.count ? Number(args.count) : 20;
    if (!query)
        return { content: [{ type: "text", text: "Missing query" }] };
    const res = await slack.search.messages({ query, count });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
});
server.tool("slack_search_channel", "Search for keywords in a channel. Args: { channel, keywords }", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const channel = String(args.channel || "");
    const keywords = String(args.keywords || "");
    if (!channel || !keywords)
        return { content: [{ type: "text", text: "Missing channel or keywords" }] };
    const query = `${keywords} in:#${channel}`;
    const res = await slack.search.messages({ query });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
});
const transport = new stdio_1.StdioServerTransport();
server.connect(transport);
