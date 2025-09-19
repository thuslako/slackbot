import "dotenv/config";
import express, { json, urlencoded } from "express";
import initSlack from "./slack";
import { sentryRouter } from "./routes/webhooks.sentry";
import { gitlabRouter } from "./routes/webhooks.gitlab";
import { env } from "./env";

const app = express();

// Webhooks
app.use("/webhooks/sentry", sentryRouter, json(), urlencoded({ extended: true }));
app.use("/webhooks/gitlab", gitlabRouter, json(), urlencoded({ extended: true }));

initSlack(app);

app.get("/healthz", (_req, res) => res.send("ok"));

app.listen(env.PORT, () => {
  console.log(`Listening on :${env.PORT}`);
});

