import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { resolve } from "node:path";

dotenv.config({ path: resolve(__dirname, "../../backend/.env") });

function requiredEnvironment(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Falta ${name}`);
  }

  return value;
}

const supabase = createClient(
  requiredEnvironment("SUPABASE_URL"),
  requiredEnvironment("SUPABASE_PUBLISHABLE_KEY"),
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  }
);

async function main() {
  const email = requiredEnvironment("AUTH_SMOKE_EMAIL");
  const password = requiredEnvironment("AUTH_SMOKE_PASSWORD");

  const signUp = await supabase.auth.signUp({ email, password });

  if (signUp.error && !/already registered/i.test(signUp.error.message)) {
    throw signUp.error;
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    throw error;
  }

  if (!data.user || !data.session) {
    throw new Error("Supabase no devolvió una sesión para el usuario de prueba");
  }

  console.log(`Auth smoke test OK: ${data.user.email} (${data.user.id})`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
