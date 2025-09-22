"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_1 = require("@modelcontextprotocol/sdk/server/mcp");
const stdio_1 = require("@modelcontextprotocol/sdk/server/stdio");
const GITLAB_HOST = process.env.GITLAB_HOST || "https://gitlab.com";
const GITLAB_TOKEN = process.env.GITLAB_TOKEN || "";
async function gl(path, init) {
    if (!GITLAB_TOKEN)
        throw new Error("GITLAB_TOKEN is required");
    const res = await fetch(`${GITLAB_HOST}/api/v4${path}`, {
        ...init,
        headers: {
            "PRIVATE-TOKEN": GITLAB_TOKEN,
            "Content-Type": "application/json",
            ...(init?.headers || {})
        }
    });
    return res;
}
const server = new mcp_1.McpServer({ name: "gitlab-mcp", version: "0.1.0" });
server.tool("gitlab_list_issues", "List issues for a project. Args: { projectId, state? }", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const projectId = String(args.projectId || "");
    const state = args.state ? String(args.state) : undefined;
    if (!projectId) {
        return { content: [{ type: "text", text: "Missing projectId" }] };
    }
    const q = state ? `&state=${encodeURIComponent(state)}` : "";
    const res = await gl(`/projects/${encodeURIComponent(projectId)}/issues?per_page=20${q}`);
    const text = await res.text();
    return { content: [{ type: "text", text }] };
});
server.tool("gitlab_create_issue", "Create issue. Args: { projectId, title, description? }", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const projectId = String(args.projectId || "");
    const title = String(args.title || "");
    const description = args.description ? String(args.description) : undefined;
    if (!projectId || !title) {
        return { content: [{ type: "text", text: "Missing projectId or title" }] };
    }
    const res = await gl(`/projects/${encodeURIComponent(projectId)}/issues`, {
        method: "POST",
        body: JSON.stringify({ title, description })
    });
    const text = await res.text();
    return { content: [{ type: "text", text }] };
});
server.tool("gitlab_list_mrs", "List merge requests. Args: { projectId, state? }", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const projectId = String(args.projectId || "");
    const state = args.state ? String(args.state) : undefined;
    if (!projectId) {
        return { content: [{ type: "text", text: "Missing projectId" }] };
    }
    const q = state ? `&state=${encodeURIComponent(state)}` : "";
    const res = await gl(`/projects/${encodeURIComponent(projectId)}/merge_requests?per_page=20${q}`);
    const text = await res.text();
    return { content: [{ type: "text", text }] };
});
// Start stdio transport
const transport = new stdio_1.StdioServerTransport();
server.connect(transport);
