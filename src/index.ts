import "dotenv/config";
import express from "express";
import initSlack from "./slack"; 

const app = express();
initSlack(app);

app.get("/", (_req, res) => res.send("ok"));
app.get("/healthz", (_req, res) => res.send("ok"));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Listening on :${port}`));
