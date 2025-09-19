"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const express_2 = require("express");
const slack_1 = require("./slack");
const webhooks_sentry_1 = require("./routes/webhooks.sentry");
const webhooks_gitlab_1 = require("./routes/webhooks.gitlab");
const env_1 = require("./env");
const app = (0, express_1.default)();
app.use((0, express_2.json)({ limit: "2mb" }));
app.use((0, express_2.urlencoded)({ extended: true }));
// Webhooks
app.use("/webhooks/sentry", webhooks_sentry_1.sentryRouter);
app.use("/webhooks/gitlab", webhooks_gitlab_1.gitlabRouter);
// Slack
(0, slack_1.initSlack)(app);
// Health
app.get("/healthz", (_req, res) => res.send("ok"));
app.listen(env_1.env.PORT, () => {
    console.log(`Server listening on :${env_1.env.PORT}`);
});
