import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseCredentials } from "./config";

export function createClient() {
  const { url, key } = getSupabaseCredentials();
  return createBrowserClient(url, key);
}
