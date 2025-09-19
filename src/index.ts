import "dotenv/config";
import express, { json, urlencoded } from "express";
import receiver from "./slack";
import initSlack from "./slack";
import { env } from "./env";

const app = express();
app.use(json());
app.use(urlencoded({ extended: true }));

initSlack(app);

app.get("/healthz", (_req, res) => res.send("ok"));

// Mount Bolt’s ExpressReceiver app → exposes /slack/events & /slack/interactive
app.use(receiver.app);

app.listen(env.PORT, () => {
  console.log(`Listening on :${env.PORT}`);
});

