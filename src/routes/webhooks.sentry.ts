import { Router } from "express";
import { addEvent } from "../store";
import { env } from "../env";
export const sentryRouter = Router();

function verify(req: any) {
  if (!env.SENTRY_WEBHOOK_SECRET) return true; // skip if not set
  return req.get("Sentry-Hook-Signature") === env.SENTRY_WEBHOOK_SECRET;
}

sentryRouter.post("/", (req, res) => {
  if (!verify(req)) return res.status(401).send("bad signature");
  const body = req.body || {};
  const project = body.project || body?.data?.issue?.project || "unknown";
  const title =
    body.title ||
    body?.data?.issue?.title ||
    body?.message ||
    "Sentry alert";
  const url = body.url || body?.web_url || body?.data?.issue?.url;
  const kind = body.action || "alert";

  addEvent({
    ts: Date.now(),
    source: "sentry",
    project: String(project),
    kind: String(kind),
    title: String(title),
    url,
    details: body
  });

  res.json({ ok: true });
});
