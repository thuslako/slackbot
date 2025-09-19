import "dotenv/config";
import express, { json, urlencoded } from "express";
import initSlack from "./slack";
import { sentryRouter } from "./routes/webhooks.sentry";
import { gitlabRouter } from "./routes/webhooks.gitlab";
import { env } from "./env";

const app = express();
app.use(json({ limit: "2mb" }));
app.use(urlencoded({ extended: true }));

// Webhooks
app.use("/webhooks/sentry", sentryRouter);
app.use("/webhooks/gitlab", gitlabRouter);

initSlack(app);

app.get("/healthz", (_req, res) => res.send("ok"));

app.listen(env.PORT, () => {
  console.log(`Listening on :${env.PORT}`);
});

