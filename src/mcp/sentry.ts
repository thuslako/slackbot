import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const SENTRY_HOST = process.env.SENTRY_HOST || "https://sentry.io";
const SENTRY_TOKEN = process.env.SENTRY_TOKEN || "";
const DEFAULT_ORG = process.env.SENTRY_ORG;
const PROJECT_FILTER: string[] = String(process.env.SENTRY_PROJECTS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

async function sentry(path: string, init?: any) {
  if (!SENTRY_TOKEN) throw new Error("SENTRY_TOKEN is required");
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

const server = new McpServer({ name: "sentry-mcp", version: "0.1.0" });

// List projects in an organization
server.tool(
  "sentry_list_projects",
  "List Sentry projects. Args: { org? } (falls back to env SENTRY_ORG)",
  async (extra: any) => {
    const args = (extra?.request?.params as any)?.arguments || {};
    const org = String(args.org || DEFAULT_ORG || "");
    if (!org) return { content: [{ type: "text", text: "Missing org (provide arg org or set SENTRY_ORG)" }] };
    const res = await sentry(`/organizations/${encodeURIComponent(org)}/projects/?per_page=50`);
    const text = await res.text();
    return { content: [{ type: "text", text }] };
  }
);

// List issues for a project (supports env, time window via statsPeriod or since/until)
server.tool(
  "sentry_list_issues",
  "List issues. Args: { project: string, org?, query?, limit?, environment?, statsPeriod?, since?, until? }",
  async (extra: any) => {
    const args = (extra?.request?.params as any)?.arguments || {};
    const org = String(args.org || DEFAULT_ORG || "");
    const project = String(args.project || "");
    const query = args.query ? String(args.query) : undefined;
    const limit = args.limit ? Number(args.limit) : 20;
    const environment = args.environment ? String(args.environment) : undefined;
    const statsPeriod = args.statsPeriod ? String(args.statsPeriod) : undefined; // e.g., 2h, 1d
    const since = args.since ? String(args.since) : undefined; // ISO
    const until = args.until ? String(args.until) : undefined; // ISO
    if (!org || !project) return { content: [{ type: "text", text: "Missing org or project" }] };
    const q = new URLSearchParams();
    if (query) q.set("query", query);
    q.set("per_page", String(limit));
    if (environment) q.set("environment", environment);
    if (statsPeriod) q.set("statsPeriod", statsPeriod);
    if (since) q.set("since", since);
    if (until) q.set("until", until);
    const res = await sentry(`/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?${q.toString()}`);
    const text = await res.text();
    return { content: [{ type: "text", text }] };
  }
);

// Org-wide: list issues across all projects (filtered by environment/time)
server.tool(
  "sentry_list_issues_org",
  "List issues across all projects. Args: { org?, environment?, statsPeriod?, since?, until?, limitPerProject? }",
  async (extra: any) => {
    const args = (extra?.request?.params as any)?.arguments || {};
    const org = String(args.org || DEFAULT_ORG || "");
    const environment = args.environment ? String(args.environment) : undefined;
    const statsPeriod = args.statsPeriod ? String(args.statsPeriod) : undefined;
    const since = args.since ? String(args.since) : undefined;
    const until = args.until ? String(args.until) : undefined;
    const limitPerProject = args.limitPerProject ? Number(args.limitPerProject) : 20;
    if (!org) return { content: [{ type: "text", text: "Missing org" }] };
    const projectsRes = await sentry(`/organizations/${encodeURIComponent(org)}/projects/?per_page=200`);
    const projectsText = await projectsRes.text();
    let projects: any[] = [];
    try { projects = JSON.parse(projectsText); } catch { /* keep empty */ }
    if (PROJECT_FILTER.length > 0) {
      const allow = new Set(PROJECT_FILTER);
      projects = projects.filter((p: any) => allow.has(String(p?.slug || "")));
    }
    const results: Record<string, any> = {};
    for (const p of projects) {
      const slug = p?.slug;
      if (!slug) continue;
      const q = new URLSearchParams();
      q.set("per_page", String(limitPerProject));
      if (environment) q.set("environment", environment);
      if (statsPeriod) q.set("statsPeriod", statsPeriod);
      if (since) q.set("since", since);
      if (until) q.set("until", until);
      const r = await sentry(`/projects/${encodeURIComponent(org)}/${encodeURIComponent(slug)}/issues/?${q.toString()}`);
      const t = await r.text();
      results[slug] = (() => { try { return JSON.parse(t); } catch { return t; } })();
    }
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

// List recent events for a specific issue
server.tool(
  "sentry_issue_events",
  "List events for an issue. Args: { issueId: string, limit? }",
  async (extra: any) => {
    const args = (extra?.request?.params as any)?.arguments || {};
    const issueId = String(args.issueId || "");
    const limit = args.limit ? Number(args.limit) : 20;
    if (!issueId) return { content: [{ type: "text", text: "Missing issueId" }] };
    const res = await sentry(`/issues/${encodeURIComponent(issueId)}/events/?per_page=${limit}`);
    const text = await res.text();
    return { content: [{ type: "text", text }] };
  }
);

// Start stdio transport
const transport = new StdioServerTransport();
server.connect(transport);


