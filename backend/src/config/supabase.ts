import { createClient } from "@supabase/supabase-js";

import "./environment";

function requiredEnvironment(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Falta ${name}`);
  }

  return value;
}

const supabaseUrl = requiredEnvironment("SUPABASE_URL");

const serverAuthOptions = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
};

// This client is the only one that can access the domain tables. It must never
// be imported by browser code.
export const supabaseAdmin = createClient(
  supabaseUrl,
  requiredEnvironment("SUPABASE_SECRET_KEY"),
  serverAuthOptions
);

// This client verifies dashboard access tokens. The publishable key is safe
// for browser use but still lets the server validate a supplied JWT.
export const supabaseAuth = createClient(
  supabaseUrl,
  requiredEnvironment("SUPABASE_PUBLISHABLE_KEY"),
  serverAuthOptions
);
