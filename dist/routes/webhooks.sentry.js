"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const store_1 = require("../store");
const env_1 = require("../env");
const sentryRouter = (0, express_1.Router)();
function verify(req) {
    if (!env_1.env.SENTRY_WEBHOOK_SECRET)
        return true; // skip if not set
    return req.get("Sentry-Hook-Signature") === env_1.env.SENTRY_WEBHOOK_SECRET;
}
sentryRouter.post("/", (req, res) => {
    if (!verify(req))
        return res.status(401).send("bad signature");
    const body = req.body || {};
    const project = body.project || body?.data?.issue?.project || "unknown";
    const title = body.title ||
        body?.data?.issue?.title ||
        body?.message ||
        "Sentry alert";
    const url = body.url || body?.web_url || body?.data?.issue?.url;
    const kind = body.action || "alert";
    (0, store_1.addEvent)({
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
exports.default = sentryRouter;
