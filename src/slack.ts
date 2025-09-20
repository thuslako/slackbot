import { App, ExpressReceiver } from "@slack/bolt";
import type { Express } from "express";
import { env } from "./env";
import { getEvents } from "./store";
import type { SlackCommandMiddlewareArgs } from "@slack/bolt";
import OpenAI from "openai";


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

  // Mount Bolt’s Express app onto our server
  app.use(receiver.app);
}

export default initSlack;

