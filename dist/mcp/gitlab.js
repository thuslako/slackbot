"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
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
const server = new mcp_js_1.McpServer({ name: "gitlab-mcp", version: "0.1.0" });
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
server.tool("gitlab_list_mrs", "List merge requests. Args: { projectId, state?, sourceBranch?, updatedAfter? }", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const projectId = String(args.projectId || "");
    const state = args.state ? String(args.state) : undefined;
    const sourceBranch = args.sourceBranch ? String(args.sourceBranch) : undefined;
    const updatedAfter = args.updatedAfter ? String(args.updatedAfter) : undefined; // ISO
    if (!projectId) {
        return { content: [{ type: "text", text: "Missing projectId" }] };
    }
    const params = new URLSearchParams();
    params.set("per_page", "20");
    if (state)
        params.set("state", state);
    if (sourceBranch)
        params.set("source_branch", sourceBranch);
    if (updatedAfter)
        params.set("updated_after", updatedAfter);
    const res = await gl(`/projects/${encodeURIComponent(projectId)}/merge_requests?${params.toString()}`);
    const text = await res.text();
    return { content: [{ type: "text", text }] };
});
//get comments from a merge request
server.tool("gitlab_get_comments", "Get comments from a merge request. Args: { projectId, mergeRequestId }", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const projectId = String(args.projectId || "");
    const mergeRequestId = String(args.mergeRequestId || "");
    if (!projectId || !mergeRequestId) {
        return { content: [{ type: "text", text: "Missing projectId or mergeRequestId" }] };
    }
    const res = await gl(`/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mergeRequestId)}/comments`);
    const text = await res.text();
    return { content: [{ type: "text", text }] };
});
// Find related ticket/MR by issue title
server.tool("gitlab_find_related_ticket", "Find related ticket/MR by issue title. Args: { issueTitle: string, projectId: string }", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const issueTitle = String(args.issueTitle || "");
    const projectId = String(args.projectId || "");
    if (!issueTitle || !projectId)
        return { content: [{ type: "text", text: "Missing issueTitle or projectId" }] };
    // Search issues
    const issuesRes = await gl(`/projects/${encodeURIComponent(projectId)}/issues?search=${encodeURIComponent(issueTitle)}&per_page=5`);
    const issuesText = await issuesRes.text();
    let issues = [];
    try {
        issues = JSON.parse(issuesText);
    }
    catch { /* keep empty */ }
    // Search MRs
    const mrsRes = await gl(`/projects/${encodeURIComponent(projectId)}/merge_requests?search=${encodeURIComponent(issueTitle)}&per_page=5`);
    const mrsText = await mrsRes.text();
    let mrs = [];
    try {
        mrs = JSON.parse(mrsText);
    }
    catch { /* keep empty */ }
    // Return the most relevant match
    const all = [...issues, ...mrs].filter(item => item?.title?.toLowerCase().includes(issueTitle.toLowerCase().slice(0, 50)));
    if (all.length === 0)
        return { content: [{ type: "text", text: "No related tickets found" }] };
    const best = all[0];
    return { content: [{ type: "text", text: JSON.stringify(best, null, 2) }] };
});
// Get comments for a ticket
server.tool("gitlab_get_ticket_comments", "Get comments for a ticket. Args: { ticketId: string, ticketType: string }", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const ticketId = String(args.ticketId || "");
    const ticketType = String(args.ticketType || "issue"); // "issue" or "merge_request"
    if (!ticketId)
        return { content: [{ type: "text", text: "Missing ticketId" }] };
    const endpoint = ticketType === "merge_request" ? "merge_request" : "issue";
    const res = await gl(`/projects/${encodeURIComponent(process.env.GITLAB_PROJECT || "")}/${endpoint}s/${ticketId}/notes?per_page=20`);
    const text = await res.text();
    let comments = [];
    try {
        comments = JSON.parse(text);
    }
    catch { /* keep empty */ }
    return { content: [{ type: "text", text: JSON.stringify(comments, null, 2) }] };
});
// Start stdio transport
const transport = new stdio_js_1.StdioServerTransport();
server.connect(transport);
