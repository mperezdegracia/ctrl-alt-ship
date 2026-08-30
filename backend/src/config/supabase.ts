import { createClient } from "@supabase/supabase-js";

import { environment } from "./environment";

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
  environment.SUPABASE_URL,
  environment.SUPABASE_SECRET_KEY,
  serverAuthOptions
);

// This client verifies dashboard access tokens. The publishable key is safe
// for browser use but still lets the server validate a supplied JWT.
export const supabaseAuth = createClient(
  environment.SUPABASE_URL,
  environment.SUPABASE_PUBLISHABLE_KEY,
  serverAuthOptions
);
