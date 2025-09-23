"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
require("dotenv/config");
const zod_1 = require("zod");
const envSchema = zod_1.z.object({
    PORT: zod_1.z.coerce.number().default(3000),
    SLACK_BOT_TOKEN: zod_1.z.string(),
    SLACK_SIGNING_SECRET: zod_1.z.string(),
    OPENAI_API_KEY: zod_1.z.string(),
    SENTRY_HOST: zod_1.z.string().optional(),
    SENTRY_ORG: zod_1.z.string().optional(),
    SENTRY_TOKEN: zod_1.z.string().optional(),
    SENTRY_PROJECTS: zod_1.z.string().optional(),
    GITLAB_HOST: zod_1.z.string().optional(),
    GITLAB_TOKEN: zod_1.z.string().optional(),
});
exports.env = envSchema.parse(process.env);
