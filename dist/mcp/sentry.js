"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_1 = require("@modelcontextprotocol/sdk/server/mcp");
const stdio_1 = require("@modelcontextprotocol/sdk/server/stdio");
const SENTRY_HOST = process.env.SENTRY_HOST || "https://sentry.io";
const SENTRY_TOKEN = process.env.SENTRY_TOKEN || "";
const DEFAULT_ORG = process.env.SENTRY_ORG;
async function sentry(path, init) {
    if (!SENTRY_TOKEN)
        throw new Error("SENTRY_TOKEN is required");
    const res = await fetch(`${SENTRY_HOST}/api/0${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${SENTRY_TOKEN}`,
            "Content-Type": "application/json",
            ...(init?.headers || {})
        }
    });
    return res;
}
const server = new mcp_1.McpServer({ name: "sentry-mcp", version: "0.1.0" });
// List projects in an organization
server.tool("sentry_list_projects", "List Sentry projects. Args: { org? } (falls back to env SENTRY_ORG)", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const org = String(args.org || DEFAULT_ORG || "");
    if (!org)
        return { content: [{ type: "text", text: "Missing org (provide arg org or set SENTRY_ORG)" }] };
    const res = await sentry(`/organizations/${encodeURIComponent(org)}/projects/?per_page=50`);
    const text = await res.text();
    return { content: [{ type: "text", text }] };
});
// List issues for a project
server.tool("sentry_list_issues", "List issues. Args: { project: string, org?, query?, limit? }", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const org = String(args.org || DEFAULT_ORG || "");
    const project = String(args.project || "");
    const query = args.query ? String(args.query) : undefined;
    const limit = args.limit ? Number(args.limit) : 20;
    if (!org || !project)
        return { content: [{ type: "text", text: "Missing org or project" }] };
    const q = new URLSearchParams();
    if (query)
        q.set("query", query);
    q.set("per_page", String(limit));
    const res = await sentry(`/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?${q.toString()}`);
    const text = await res.text();
    return { content: [{ type: "text", text }] };
});
// List recent events for a specific issue
server.tool("sentry_issue_events", "List events for an issue. Args: { issueId: string, limit? }", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const issueId = String(args.issueId || "");
    const limit = args.limit ? Number(args.limit) : 20;
    if (!issueId)
        return { content: [{ type: "text", text: "Missing issueId" }] };
    const res = await sentry(`/issues/${encodeURIComponent(issueId)}/events/?per_page=${limit}`);
    const text = await res.text();
    return { content: [{ type: "text", text }] };
});
// Start stdio transport
const transport = new stdio_1.StdioServerTransport();
server.connect(transport);
