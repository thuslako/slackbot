import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import type { Express } from "express";
import { env } from "./env";
import { getEvents } from "./store";
import type { SlackCommandMiddlewareArgs } from "@slack/bolt";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";


const parseSinceToMinutes = (text: string, defaultMinutes = 120): number => {
    // Accepts: since 30m | 2h | 1w (also “mins/min/minute/minutes”, “hr/hrs/hour/hours”, “wk/wks/week/weeks”)
    // Case-insensitive, ignores extra spaces. First match wins.
    const m = text.toLowerCase().match(
      /since\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|w|wk|wks|week|weeks)\b/
    );
  
    if (!m) {
      // special case: "since today"
      if (/since\s+today\b/i.test(text)) {
        const now = new Date();
        const startOfDay = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          0, 0, 0, 0
        );
        return Math.max(1, Math.floor((now.getTime() - startOfDay.getTime()) / 60000));
      }
      return defaultMinutes;
    }
  
    const value = parseInt(m[1], 10);
    const unit = m[2];
  
    if (Number.isNaN(value) || value < 0) return defaultMinutes;
  
    // Convert to minutes
    const toMinutes = (u: string) => {
      if (/(^m$|^min$|^mins$|^minute$|^minutes$)/.test(u)) return value;
      if (/(^h$|^hr$|^hrs$|^hour$|^hours$)/.test(u)) return value * 60;
      if (/(^w$|^wk$|^wks$|^week$|^weeks$)/.test(u)) return value * 7 * 24 * 60;
      return value; // fallback (shouldn’t hit)
    };
  
    return toMinutes(unit);
  }
  

const initSlack = (app: Express) => {
  const receiver = new ExpressReceiver({
    signingSecret: env.SLACK_SIGNING_SECRET,
    endpoints: { events: "/slack/events", interactions: "/slack/interactive" }
  });

  const slack = new App({
    token: env.SLACK_BOT_TOKEN,
    receiver,
    logLevel: LogLevel.DEBUG
  });

  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  // Minimal MCP client manager for GitLab and Sentry
  const mcpClients: Record<string, Client | undefined> = {};
  const ensureMcpClient = async (
    key: "gitlab" | "sentry" | "slack"
  ): Promise<Client> => {
    if (mcpClients[key]) return mcpClients[key] as Client;
    console.log(`[mcp] starting ${key} client`);
    const command = process.execPath; // node executable
    const script = key === "gitlab"
      ? "dist/mcp/gitlab.js"
      : key === "sentry"
      ? "dist/mcp/sentry.js"
      : "dist/mcp/slack.js";
    const args = [script];
    const extraEnv: Record<string, string> = key === "gitlab"
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
    const transport = new StdioClientTransport({
      command,
      args,
      env: { ...process.env as any, ...extraEnv },
      stderr: "pipe" // Change to "pipe" to log stderr
    });
    transport.stderr?.on("data", (data) => {
      console.error(`[mcp ${key} stderr] ${data.toString().trim()}`);
    });
    const client = new Client({ name: `oncallbot-${key}-client`, version: "0.1.0" });
    await client.connect(transport);
    console.log(`[mcp] connected ${key}`);
    mcpClients[key] = client;
    return client;
  };



  // /sentry-issues project=<slug> [org=<org>] [query=...] [limit=20]
  slack.command("/sentry-issues", async ({ ack, respond, command }: SlackCommandMiddlewareArgs) => {
    await ack();
    const text = (command.text || "").trim();
    const args: Record<string, string> = {};
    for (const part of text.split(/\s+/).filter(Boolean)) {
      const idx = part.indexOf("=");
      if (idx > 0) args[part.slice(0, idx)] = part.slice(idx + 1);
      else if (!args.project) args.project = part;
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
          project: args.project || env.SENTRY_PROJECTS,
          org: args.org || env.SENTRY_ORG,
          query: args.query || "",
          limit: args.limit ? Number(args.limit) : undefined
        }
      }, undefined, { timeout: 20000 });
      const contentAny: any = (result as any).content || [];
      const textOut = (Array.isArray(contentAny) ? contentAny : [])
        .map((c: any) => (c?.type === "text" ? c.text : ""))
        .join("\n");
      await respond({ response_type: "ephemeral", text: textOut.slice(0, 3500) || "No results." });
    } catch (err: any) {
      await respond({ response_type: "ephemeral", text: `Error: ${err?.message || String(err)}` });
    }
  });

  // /gitlab-mrs <projectIdOrPath> [state]
  slack.command("/gitlab-mrs", async ({ ack, respond, command }: SlackCommandMiddlewareArgs) => {
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
      const contentAny: any = (result as any).content || [];
      const textOut = (Array.isArray(contentAny) ? contentAny : [])
        .map((c: any) => (c?.type === "text" ? c.text : ""))
        .join("\n");
      await respond({ response_type: "ephemeral", text: textOut.slice(0, 3500) || "No results." });
    } catch (err: any) {
      await respond({ response_type: "ephemeral", text: `Error: ${err?.message || String(err)}` });
    }
  });

  // /oncall-report <timeRange>
  slack.command("/oncall-report", async ({ ack, respond, command }: SlackCommandMiddlewareArgs) => {
    await ack();
    const text = (command.text || "").trim();
    console.log(`/oncall-report invoked: "${text}" by ${command.user_id}`);
    const timeRange = text || "1w"; // e.g., 30m, 2h, 1d
    console.log(`/oncall-report parsed: timeRange=${timeRange}`);

    try {
      // Time window params
      const statsPeriod = /^(\d+)(m|h|d|w)$/.test(timeRange) ? timeRange : "2h";

      // Get Sentry issues for the time range
      console.log(`[mcp] calling sentry_list_issues_time_range with org=${env.SENTRY_ORG}, statsPeriod=${statsPeriod}`);
      const t0 = Date.now();
      const se = await ensureMcpClient("sentry");
      const seRes = await se.callTool({
        name: "sentry_list_issues_time_range",
        arguments: { org: env.SENTRY_ORG, statsPeriod, limitPerProject: 50 }
      }, undefined, { timeout: 30000 });
      const seContent: any = (seRes as any).content || [];
      const sentryText = (Array.isArray(seContent) ? seContent : []).map((c: any) => (c?.type === "text" ? c.text : "")).join("\n");
      console.log(`[mcp] sentry_list_issues_time_range done in ${Date.now()-t0}ms, response bytes=${JSON.stringify(seRes).length}, parsed length=${sentryText.length}`);

      // For each Sentry issue, find related GitLab tickets and track in Slack
      let issueCorrelations = [];
      try {
        const sentryIssues = JSON.parse(sentryText);
        issueCorrelations = [];

        for (const [projectSlug, issues] of Object.entries(sentryIssues as Record<string, any[]>)) {
          for (const issue of issues) {
            console.log(`[correlation] processing Sentry issue: ${issue.title} (${issue.id})`);

            // Find related GitLab ticket
            const gl = await ensureMcpClient("gitlab");
            const glRes = await gl.callTool({
              name: "gitlab_find_related_ticket",
              arguments: { issueTitle: issue.title, projectId: process.env.GITLAB_PROJECT }
            }, undefined, { timeout: 15000 });
            const glContent: any = (glRes as any).content || [];
            const gitlabTicket = (Array.isArray(glContent) ? glContent : []).find((c: any) => c?.type === "text" && c.text);

            if (gitlabTicket) {
              console.log(`[correlation] found GitLab ticket: ${gitlabTicket}`);

              // Get GitLab ticket comments
              const glCommentsRes = await gl.callTool({
                name: "gitlab_get_ticket_comments",
                arguments: { ticketId: gitlabTicket.id, ticketType: gitlabTicket.type }
              }, undefined, { timeout: 15000 });
              const glCommentsContent: any = (glCommentsRes as any).content || [];
              const comments = (Array.isArray(glCommentsContent) ? glCommentsContent : []).map((c: any) => (c?.type === "text" ? c.text : "")).join("\n");

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
              const skContent: any = (skRes as any).content || [];
              const trackingResult = (Array.isArray(skContent) ? skContent : []).map((c: any) => (c?.type === "text" ? c.text : "")).join("\n");

              issueCorrelations.push({
                sentryIssue: issue,
                gitlabTicket: gitlabTicket,
                comments: comments,
                slackTracking: trackingResult
              });
            } else {
              console.log(`[correlation] no GitLab ticket found for: ${issue.title}`);
            }
          }
        }

        console.log(`[correlation] processed ${issueCorrelations.length} issue correlations`);
      } catch (err) {
        console.error(`[correlation] error: ${err}`);
      }

      // Compose detailed report prompt
      const reportPrompt = [
        "You are an SRE copilot. Create a detailed on-call report with the following structure:",
        "",
        "## Critical Issues Requiring Attention",
        "- For each critical Sentry issue, include:",
        "  - Issue title and URL",
        "  - Related GitLab ticket/MR if found",
        "  - Latest comments from GitLab",
        "  - Slack tracking status",
        "  - Severity and impact assessment",
        "",
        "## Recent Activity Summary",
        "- Total issues found in time range",
        "- Issues with GitLab correlation",
        "- Issues being tracked in Slack",
        "- Overall system health assessment",
        "",
        "Use emojis, bullets, and include all relevant URLs. Be concise but comprehensive.",
        "",
        "Sentry Issues JSON:",
        sentryText,
        "",
        "Issue Correlations JSON:",
        JSON.stringify(issueCorrelations, null, 2)
      ].join("\n");

      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        temperature: 0.2,
        messages: [{ role: "user", content: reportPrompt }]
      });

      await respond({ response_type: "ephemeral", text: completion.choices[0]?.message?.content ?? "No summary generated." });
    } catch (err: any) {
      console.error(`[oncall-report] error: ${err}`);
      await respond({ response_type: "ephemeral", text: `Error: ${err?.message || String(err)}` });
    }
  });

  // Mount Bolt’s Express app onto our server
  app.use(receiver.app);
}

export default initSlack;

