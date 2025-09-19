import { Router } from "express";
import { addEvent } from "../store";
import { env } from "../env";
export const gitlabRouter = Router();

function verify(req: any) {
  if (!env.GITLAB_WEBHOOK_SECRET) return true;
  return req.get("X-Gitlab-Token") === env.GITLAB_WEBHOOK_SECRET;
}

gitlabRouter.post("/", (req, res) => {
  if (!verify(req)) return res.status(401).send("bad token");

  const b = req.body || {};
  const kind = b.object_kind;
  const project =
    b?.project?.path_with_namespace ||
    b?.project?.name ||
    "unknown";

  let title = "GitLab event";
  let url: string | undefined;

  if (kind === "merge_request") {
    const mr = b.object_attributes || {};
    title = `MR ${mr.source_branch} → ${mr.target_branch}: ${mr.title} (${mr.state})`;
    url = mr.url || mr.web_url;
  } else if (kind === "pipeline") {
    const p = b.object_attributes || {};
    title = `Pipeline ${p.status} on ${p.ref}`;
    url = p.url;
  } else if (kind === "push") {
    title = `Push to ${b.ref}`;
    url = b?.project?.web_url;
  }

  addEvent({
    ts: Date.now(),
    source: "gitlab",
    project: String(project),
    kind: String(kind || "event"),
    title: String(title),
    url,
    details: b
  });

  res.json({ ok: true });
});
