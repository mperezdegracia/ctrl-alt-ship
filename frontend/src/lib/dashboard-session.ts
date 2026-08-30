import { redirect } from "next/navigation";

import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

export async function requireDashboardSession(): Promise<{ accessToken: string; email: string }> {
  if (!isSupabaseConfigured) redirect("/login");
  const supabase = await createClient();
  const [{ data: claimsData }, { data: sessionData }] = await Promise.all([
    supabase.auth.getClaims(),
    supabase.auth.getSession(),
  ]);
  if (!claimsData?.claims || !sessionData.session?.access_token) redirect("/login");
  return {
    accessToken: sessionData.session.access_token,
    email: typeof claimsData.claims.email === "string" ? claimsData.claims.email : "Operator",
  };
}
