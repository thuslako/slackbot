import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const GITLAB_HOST = process.env.GITLAB_HOST || "https://gitlab.com";
const GITLAB_TOKEN = process.env.GITLAB_TOKEN || "";

async function gl(path: string, init?: any) {
  if (!GITLAB_TOKEN) throw new Error("GITLAB_TOKEN is required");
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

const server = new McpServer({ name: "gitlab-mcp", version: "0.1.0" });

server.tool(
  "gitlab_list_issues",
  "List issues for a project. Args: { projectId, state? }",
  async (extra: any) => {
    const args = (extra?.request?.params as any)?.arguments || {};
    const projectId = String(args.projectId || "");
    const state = args.state ? String(args.state) : undefined;
    if (!projectId) {
      return { content: [{ type: "text", text: "Missing projectId" }] };
    }
    const q = state ? `&state=${encodeURIComponent(state)}` : "";
    const res = await gl(`/projects/${encodeURIComponent(projectId)}/issues?per_page=20${q}`);
    const text = await res.text();
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "gitlab_create_issue",
  "Create issue. Args: { projectId, title, description? }",
  async (extra: any) => {
    const args = (extra?.request?.params as any)?.arguments || {};
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
  }
);

server.tool(
  "gitlab_list_mrs",
  "List merge requests. Args: { projectId, state?, sourceBranch?, updatedAfter? }",
  async (extra: any) => {
    const args = (extra?.request?.params as any)?.arguments || {};
    const projectId = String(args.projectId || "");
    const state = args.state ? String(args.state) : undefined;
    const sourceBranch = args.sourceBranch ? String(args.sourceBranch) : undefined;
    const updatedAfter = args.updatedAfter ? String(args.updatedAfter) : undefined; // ISO
    if (!projectId) {
      return { content: [{ type: "text", text: "Missing projectId" }] };
    }
    const params = new URLSearchParams();
    params.set("per_page", "20");
    if (state) params.set("state", state);
    if (sourceBranch) params.set("source_branch", sourceBranch);
    if (updatedAfter) params.set("updated_after", updatedAfter);
    const res = await gl(`/projects/${encodeURIComponent(projectId)}/merge_requests?${params.toString()}`);
    const text = await res.text();
    return { content: [{ type: "text", text }] };
  }
);

//get comments from a merge request
server.tool(
  "gitlab_get_comments",
  "Get comments from a merge request. Args: { projectId, mergeRequestId }",
  async (extra: any) => {
    const args = (extra?.request?.params as any)?.arguments || {};
    const projectId = String(args.projectId || "");
    const mergeRequestId = String(args.mergeRequestId || "");
    if (!projectId || !mergeRequestId) {
      return { content: [{ type: "text", text: "Missing projectId or mergeRequestId" }] };
    }
    const res = await gl(`/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mergeRequestId)}/comments`);
    const text = await res.text();
    return { content: [{ type: "text", text }] };
  }
);

// Start stdio transport
const transport = new StdioServerTransport();
server.connect(transport);


