"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.gitlabRouter = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const env_1 = require("../env");
exports.gitlabRouter = (0, express_1.Router)();
function verify(req) {
    if (!env_1.env.GITLAB_WEBHOOK_SECRET)
        return true;
    return req.get("X-Gitlab-Token") === env_1.env.GITLAB_WEBHOOK_SECRET;
}
exports.gitlabRouter.post("/", (req, res) => {
    if (!verify(req))
        return res.status(401).send("bad token");
    const b = req.body || {};
    const kind = b.object_kind;
    const project = b?.project?.path_with_namespace ||
        b?.project?.name ||
        "unknown";
    let title = "GitLab event";
    let url;
    if (kind === "merge_request") {
        const mr = b.object_attributes || {};
        title = `MR ${mr.source_branch} → ${mr.target_branch}: ${mr.title} (${mr.state})`;
        url = mr.url || mr.web_url;
    }
    else if (kind === "pipeline") {
        const p = b.object_attributes || {};
        title = `Pipeline ${p.status} on ${p.ref}`;
        url = p.url;
    }
    else if (kind === "push") {
        title = `Push to ${b.ref}`;
        url = b?.project?.web_url;
    }
    (0, store_1.addEvent)({
        ts: Date.now(),
        source: "gitlab",
        project: String(project),
        kind: String(kind || "event"),
        title: String(title),
        url
    });
    res.json({ ok: true });
});
