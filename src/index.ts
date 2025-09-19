import "dotenv/config";
import express from "express";
import initSlack from "./slack"; 
import webhooksSentry from "./routes/webhooks.sentry";
import webhooksGitlab from "./routes/webhooks.gitlab";// your ExpressReceiver with endpoints /slack/events, /slack/interactive

const app = express();
initSlack(app);

app.use("/webhooks", express.json(), express.urlencoded({ extended: true }));

app.post("/webhooks/sentry", webhooksSentry);

app.post("/webhooks/gitlab", webhooksGitlab);

app.get("/", (_req, res) => res.send("ok"));
app.get("/healthz", (_req, res) => res.send("ok"));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Listening on :${port}`));
