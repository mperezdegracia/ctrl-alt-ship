import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { getOpenOperations } from "@/lib/mock-operations";
import { DashboardHeader } from "./dashboard-header";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  if (!isSupabaseConfigured) redirect("/login");
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData) redirect("/login");

  const email = typeof claimsData.claims.email === "string" ? claimsData.claims.email : "Supervisor";
  const operations = await getOpenOperations();
  const escalation = operations.find((operation) => operation.isEscalated);

  return (
    <main className="dashboard-shell">
      <DashboardHeader email={email} />
      <section className="dashboard-main">
        <div className="dashboard-title-row">
          <div>
            <h1>Operations</h1>
            <p>Open work across your active freight coordination.</p>
          </div>
          <p className="report-date">Friday, 29 August<br />14:42 ART</p>
        </div>

        {escalation && (
          <section className="escalation-sheet" aria-labelledby="escalation-title">
            <div className="escalation-live"><span className="live-dot" aria-hidden="true" />Live call · awaiting supervisor</div>
            <div className="escalation-copy">
              <p className="operation-reference">{escalation.reference} · {escalation.client}</p>
              <h2 id="escalation-title">A provider requested a pickup outside the Action Window.</h2>
              <p>Requested: Tue 02 Sep, 16:00–18:00 · Authorized: Mon 01 Sep, 08:00–14:00</p>
            </div>
            <div className="escalation-action">
              <p>Provider call<br /><strong>Transporte Sur</strong></p>
              <Link href={`/dashboard/operations/${escalation.reference}`}>Review operation</Link>
            </div>
          </section>
        )}

        <div className="operations-heading">
          <h2>Active operations <span>{operations.length}</span></h2>
          <p>Ordered by attention needed, then latest update.</p>
        </div>
        <div className="operations-table-wrap">
          <table className="operations-table">
            <thead>
              <tr><th>Operation</th><th>Route</th><th>Status</th><th>Next step</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {operations.map((operation) => (
                <tr key={operation.reference} className={operation.isEscalated ? "operation-row-escalated" : undefined}>
                  <td><Link href={`/dashboard/operations/${operation.reference}`}><strong>{operation.reference}</strong><span>{operation.client}</span></Link></td>
                  <td><span>{operation.origin}</span><strong>{operation.destination}</strong></td>
                  <td><span className={`status-mark status-${operation.status.toLowerCase().replaceAll(" ", "-")}`}>{operation.status}</span></td>
                  <td>{operation.nextStep}</td>
                  <td className="updated-time">{operation.updated}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
