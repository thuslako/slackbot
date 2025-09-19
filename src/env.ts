import 'dotenv/config'; 
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  SLACK_BOT_TOKEN: z.string(),
  SLACK_SIGNING_SECRET: z.string(),
  OPENAI_API_KEY: z.string(),
  SENTRY_WEBHOOK_SECRET: z.string().optional(),
  GITLAB_WEBHOOK_SECRET: z.string().optional()
});

export const env = envSchema.parse(process.env);