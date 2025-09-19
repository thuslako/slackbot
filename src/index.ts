import express from "express";
import { json, urlencoded } from "express";
import { initSlack } from "./slack";
import { sentryRouter } from "./routes/webhooks.sentry";
import { gitlabRouter } from "./routes/webhooks.gitlab";
import { env } from "./env";

const app = express();
app.use(json({ limit: "2mb" }));
app.use(urlencoded({ extended: true }));

// Webhooks
app.use("/webhooks/sentry", sentryRouter);
app.use("/webhooks/gitlab", gitlabRouter);

// Slack
initSlack(app);

// Health
app.get("/healthz", (_req, res) => res.send("ok"));

app.listen(env.PORT, () => {
  console.log(`Server listening on :${env.PORT}`);
});

export { app };
