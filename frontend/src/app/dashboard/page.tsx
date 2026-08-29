import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { DashboardHeader } from "./dashboard-header";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  if (!isSupabaseConfigured) redirect("/login");
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData) redirect("/login");

  const email = typeof claimsData.claims.email === "string" ? claimsData.claims.email : "Supervisor";

  return (
    <main className="dashboard-shell">
      <DashboardHeader email={email} />
      <section className="dashboard-main">
        <p className="section-label">Overview</p>
        <h1>Operations</h1>
        <div className="dashboard-rule" />
        <div className="dashboard-empty"><h2>No operations to show yet.</h2></div>
      </section>
    </main>
  );
}
