"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const bot_1 = __importDefault(require("./bot"));
const app = (0, express_1.default)();
(0, bot_1.default)(app);
app.get("/", (_req, res) => res.send("ok"));
app.get("/healthz", (_req, res) => res.send("ok"));
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Listening on :${port}`));
