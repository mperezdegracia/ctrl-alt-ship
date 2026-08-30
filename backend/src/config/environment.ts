import dotenv from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

// Render supplies process environment variables. During local development the
// backend owns its own ignored environment file.
dotenv.config({ path: resolve(__dirname, "../../.env") });

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  CLIENT_OPERATION_TOOLS_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  ESCALATION_SPIKE_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  ESCALATION_STALLED_TURNS: z.coerce.number().int().min(1).max(10).default(3),
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_FROM_NUMBER: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
  SUPERVISOR_PHONE: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
  PUBLIC_BASE_URL: z.url().optional(),
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  DASHBOARD_ORIGINS: z.string().min(1).default("http://localhost:3001"),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_WEBHOOK_SECRET: z.string().min(1),
});

const parsedEnvironment = environmentSchema.safeParse(process.env);

if (!parsedEnvironment.success) {
  const problems = parsedEnvironment.error.issues
    .map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");

  throw new Error(`Invalid backend environment:\n${problems}`);
}

if (parsedEnvironment.data.ESCALATION_SPIKE_ENABLED) {
  const missing = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "PUBLIC_BASE_URL"]
    .filter((key) => !parsedEnvironment.data[key as keyof typeof parsedEnvironment.data]);
  if (missing.length > 0) throw new Error(`Escalation spike requires: ${missing.join(", ")}`);
}

/**
 * The complete environment required by the HTTP/voice runtime. Importing this
 * module deliberately validates configuration before the server accepts work.
 */
export const environment = parsedEnvironment.data;
