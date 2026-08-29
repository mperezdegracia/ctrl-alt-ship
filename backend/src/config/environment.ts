import dotenv from "dotenv";
import { resolve } from "node:path";

// Render supplies process environment variables. During local development the
// backend owns its own ignored environment file.
dotenv.config({ path: resolve(__dirname, "../../.env") });
