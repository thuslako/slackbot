"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const SENTRY_HOST = process.env.SENTRY_HOST || "https://sentry.io";
const SENTRY_TOKEN = process.env.SENTRY_TOKEN || "";
const DEFAULT_ORG = process.env.SENTRY_ORG;
const PROJECT_FILTER = String(process.env.SENTRY_PROJECTS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
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
const server = new mcp_js_1.McpServer({ name: "sentry-mcp", version: "0.1.0" });
// List projects in an organization
server.tool("sentry_list_projects", "List Sentry projects. Args: { org? } (falls back to env SENTRY_ORG)", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const org = String(args.org || DEFAULT_ORG || "");
    if (!org)
        return { content: [{ type: "text", text: "Missing org (provide arg org or set SENTRY_ORG)" }] };
    try {
        const res = await sentry(`/organizations/${encodeURIComponent(org)}/projects/?per_page=50`);
        if (!res.ok) {
            const errorText = await res.text();
            console.error(`[sentry] projects API error ${res.status}: ${errorText}`);
            return { content: [{ type: "text", text: `API Error ${res.status}: ${errorText}` }] };
        }
        const text = await res.text();
        console.log(`[sentry] projects response length: ${text.length}`);
        return { content: [{ type: "text", text }] };
    }
    catch (err) {
        console.error(`[sentry] projects request failed: ${err}`);
        return { content: [{ type: "text", text: `Request failed: ${err}` }] };
    }
});
// List issues for a project (supports env, time window via statsPeriod or since/until)
server.tool("sentry_list_issues", "List issues. Args: { project: string, org?, query?, limit?, environment?, statsPeriod?, since?, until? }", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const org = String(args.org || DEFAULT_ORG || "");
    const project = String(args.project || "");
    const query = args.query ? String(args.query) : undefined;
    const limit = args.limit ? Number(args.limit) : 20;
    const environment = args.environment ? String(args.environment) : undefined;
    const statsPeriod = args.statsPeriod ? String(args.statsPeriod) : undefined; // e.g., 2h, 1d
    const since = args.since ? String(args.since) : undefined; // ISO
    const until = args.until ? String(args.until) : undefined; // ISO
    if (!org || !project)
        return { content: [{ type: "text", text: "Missing org or project" }] };
    const q = new URLSearchParams();
    if (query)
        q.set("query", query);
    q.set("per_page", String(limit));
    if (environment)
        q.set("environment", environment);
    if (statsPeriod)
        q.set("statsPeriod", statsPeriod);
    if (since)
        q.set("since", since);
    if (until)
        q.set("until", until);
    const res = await sentry(`/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?${q.toString()}`);
    const text = await res.text();
    return { content: [{ type: "text", text }] };
});
// Org-wide: list issues across all projects (filtered by environment/time)
server.tool("sentry_list_issues_org", "List issues across all projects. Args: { org?, environment?, statsPeriod?, since?, until?, limitPerProject? }", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const org = String(args.org || DEFAULT_ORG || "");
    const environment = args.environment ? String(args.environment) : undefined;
    const statsPeriod = args.statsPeriod ? String(args.statsPeriod) : undefined;
    const since = args.since ? String(args.since) : undefined;
    const until = args.until ? String(args.until) : undefined;
    const limitPerProject = args.limitPerProject ? Number(args.limitPerProject) : 20;
    if (!org)
        return { content: [{ type: "text", text: "Missing org" }] };
    const projectsRes = await sentry(`/organizations/${encodeURIComponent(org)}/projects/?per_page=200`);
    const projectsText = await projectsRes.text();
    let projects = [];
    try {
        projects = JSON.parse(projectsText);
    }
    catch { /* keep empty */ }
    if (PROJECT_FILTER.length > 0) {
        const allow = new Set(PROJECT_FILTER);
        projects = projects.filter((p) => allow.has(String(p?.slug || "")));
    }
    const results = {};
    for (const p of projects) {
        const slug = p?.slug;
        if (!slug)
            continue;
        const q = new URLSearchParams();
        q.set("per_page", String(limitPerProject));
        if (environment)
            q.set("environment", environment);
        if (statsPeriod)
            q.set("statsPeriod", statsPeriod);
        if (since)
            q.set("since", since);
        if (until)
            q.set("until", until);
        const r = await sentry(`/projects/${encodeURIComponent(org)}/${encodeURIComponent(slug)}/issues/?${q.toString()}`);
        const t = await r.text();
        results[slug] = (() => { try {
            return JSON.parse(t);
        }
        catch {
            return t;
        } })();
    }
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
});
// List issues by time range (simplified version)
server.tool("sentry_list_issues_time_range", "List issues by time range. Args: { org?, statsPeriod?, limitPerProject? }", async (extra) => {
    const args = extra?.request?.params?.arguments || {};
    const org = String(args.org || DEFAULT_ORG || "");
    const statsPeriod = args.statsPeriod ? String(args.statsPeriod) : "2h";
    const limitPerProject = args.limitPerProject ? Number(args.limitPerProject) : 20;
    if (!org)
        return { content: [{ type: "text", text: "Missing org" }] };
    try {
        const projectsRes = await sentry(`/organizations/${encodeURIComponent(org)}/projects/?per_page=200`);
        if (!projectsRes.ok) {
            const errorText = await projectsRes.text();
            console.error(`[sentry] projects API error ${projectsRes.status}: ${errorText}`);
            return { content: [{ type: "text", text: `API Error ${projectsRes.status}: ${errorText}` }] };
        }
        const projectsText = await projectsRes.text();
        console.log(`[sentry] projects response length: ${projectsText.length}`);
        let projects = [];
        try {
            projects = JSON.parse(projectsText);
            if (!Array.isArray(projects)) {
                console.error(`[sentry] projects response is not an array: ${typeof projects}`);
                return { content: [{ type: "text", text: `Error: Invalid projects response format` }] };
            }
        }
        catch (e) {
            console.error(`[sentry] failed to parse projects JSON: ${e}`);
            console.error(`[sentry] projects response text: ${projectsText}`);
            return { content: [{ type: "text", text: `Error: ${projectsText || "Failed to fetch projects"}` }] };
        }
        if (PROJECT_FILTER.length > 0) {
            const allow = new Set(PROJECT_FILTER);
            projects = projects.filter((p) => allow.has(String(p?.slug || "")));
        }
        const results = {};
        for (const p of projects) {
            const slug = p?.slug;
            if (!slug)
                continue;
            const q = new URLSearchParams();
            q.set("per_page", String(limitPerProject));
            q.set("statsPeriod", statsPeriod);
            q.set("query", "is:unresolved");
            try {
                const r = await sentry(`/projects/${encodeURIComponent(org)}/${encodeURIComponent(slug)}/issues/?${q.toString()}`);
                if (!r.ok) {
                    const errorText = await r.text();
                    console.error(`[sentry] issues API error ${r.status} for project ${slug}: ${errorText}`);
                    continue; // Skip this project
                }
                const t = await r.text();
                console.log(`[sentry] issues response for ${slug} length: ${t.length}`);
                const issues = (() => { try {
                    return JSON.parse(t);
                }
                catch {
                    return [];
                } })();
                if (Array.isArray(issues) && issues.length > 0) {
                    results[slug] = issues;
                }
            }
            catch (err) {
                console.error(`[sentry] failed to fetch issues for project ${slug}: ${err}`);
                // Continue with other projects
            }
        }
        console.log(`[sentry] completed issues fetch for ${Object.keys(results).length} projects`);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
    catch (err) {
        console.error(`[sentry] sentry_list_issues_time_range failed: ${err}`);
        return { content: [{ type: "text", text: `Request failed: ${err}` }] };
    }
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
const transport = new stdio_js_1.StdioServerTransport();
server.connect(transport);
