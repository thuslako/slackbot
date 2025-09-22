import { App, ExpressReceiver } from "@slack/bolt";
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
    receiver
  });

  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  // Minimal MCP client manager for GitLab and Sentry
  const mcpClients: Record<string, Client | undefined> = {};
  const ensureMcpClient = async (
    key: "gitlab" | "sentry" | "slack"
  ): Promise<Client> => {
    if (mcpClients[key]) return mcpClients[key] as Client;
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
    const transport = new StdioClientTransport({
      command,
      args,
      env: { ...process.env as any, ...extraEnv },
      stderr: "inherit"
    });
    const client = new Client({ name: `oncallbot-${key}-client`, version: "0.1.0" });
    await client.connect(transport);
    mcpClients[key] = client;
    return client;
  };

  slack.command("/oncall", async ({ ack, respond, command }:SlackCommandMiddlewareArgs) => {
    await ack();

    const text = (command.text || "").trim().toLowerCase();
    
    const minutes = parseSinceToMinutes(text, 120);

    const data = getEvents(minutes);

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
          project: args.project,
          org: args.org,
          query: args.query,
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

  // /oncall-report <timeRange> [branch=<sourceBranch>] [env=<sentryEnv>] [channel=<name>] [keywords=...]
  slack.command("/oncall-report", async ({ ack, respond, command }: SlackCommandMiddlewareArgs) => {
    await ack();
    const text = (command.text || "").trim();
    const tokens = text.split(/\s+/).filter(Boolean);
    const timeRange = tokens[0] || "2h"; // e.g., 30m, 2h, 1d
    const kv: Record<string, string> = {};
    for (const part of tokens.slice(1)) {
      const i = part.indexOf("=");
      if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1);
    }
    const sourceBranch = kv.branch;
    const environment = kv.env || "production";
    const channel = kv.channel;
    const keywords = kv.keywords || "incident OR error OR outage";

    try {
      // Time window params
      const statsPeriod = /^(\d+)(m|h|d|w)$/.test(timeRange) ? timeRange : "2h";
      const sinceIso = undefined;
      const untilIso = undefined;

      // GitLab MRs across specified project (optional): if you have a default project, set env.GITLAB_PROJECT
      let gitlabText = "";
      const defaultProject = process.env.GITLAB_PROJECT;
      if (defaultProject) {
        const gl = await ensureMcpClient("gitlab");
        const glRes = await gl.callTool({
          name: "gitlab_list_mrs",
          arguments: {
            projectId: defaultProject,
            state: "opened",
            sourceBranch,
            updatedAfter: undefined
          }
        }, undefined, { timeout: 20000 });
        const glContent: any = (glRes as any).content || [];
        gitlabText = (Array.isArray(glContent) ? glContent : []).map((c: any) => (c?.type === "text" ? c.text : "")).join("\n");
        if (gitlabText.length > 8000) gitlabText = gitlabText.slice(0, 8000);
      }

      // Sentry issues across org
      let sentryText = "";
      const se = await ensureMcpClient("sentry");
      const seRes = await se.callTool({
        name: "sentry_list_issues_org",
        arguments: { org: env.SENTRY_ORG, environment, statsPeriod, since: sinceIso, until: untilIso, limitPerProject: 20 }
      }, undefined, { timeout: 25000 });
      const seContent: any = (seRes as any).content || [];
      sentryText = (Array.isArray(seContent) ? seContent : []).map((c: any) => (c?.type === "text" ? c.text : "")).join("\n");
      if (sentryText.length > 16000) sentryText = sentryText.slice(0, 16000);

      // Search Slack channel (optional)
      let slackSearchText = "";
      if (channel) {
        const sk = await ensureMcpClient("slack");
        const skRes = await sk.callTool({ name: "slack_search_channel", arguments: { channel, keywords } }, undefined, { timeout: 20000 });
        const skContent: any = (skRes as any).content || [];
        slackSearchText = (Array.isArray(skContent) ? skContent : []).map((c: any) => (c?.type === "text" ? c.text : "")).join("\n");
        if (slackSearchText.length > 8000) slackSearchText = slackSearchText.slice(0, 8000);
      }

      // Compose report prompt
      const reportPrompt = [
        "You are an SRE copilot. Create a concise on-call report.",
        "Summarize unresolved Sentry issues across the organization for the specified environment and time range, correlate with GitLab open MRs (optionally filtered by source branch), and highlight notable Slack messages.",
        "Return Slack-friendly bullets, emojis, risks, and include URLs when present.",
        "Sorted by backend and frontend issues, the most critical issues  that affect the most users.",
        "GitLab MRs JSON:",
        gitlabText || "[]",
        "\nSentry Issues JSON:",
        sentryText || "[]",
        "\nSlack Messages JSON:",
        slackSearchText || "[]"
      ].join("\n");

      const completion = await openai.chat.completions.create({
        model: "gpt-5",
        temperature: 0.2,
        messages: [{ role: "user", content: reportPrompt }]
      });

      await respond({ response_type: "ephemeral", text: completion.choices[0]?.message?.content ?? "No summary." });
    } catch (err: any) {
      await respond({ response_type: "ephemeral", text: `Error: ${err?.message || String(err)}` });
    }
  });

  // Mount Bolt’s Express app onto our server
  app.use(receiver.app);
}

export default initSlack;

