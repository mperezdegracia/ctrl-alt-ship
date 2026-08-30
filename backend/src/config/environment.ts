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

/**
 * The complete environment required by the HTTP/voice runtime. Importing this
 * module deliberately validates configuration before the server accepts work.
 */
export const environment = parsedEnvironment.data;
