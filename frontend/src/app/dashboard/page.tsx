import Link from "next/link";
import { redirect } from "next/navigation";

import {
  formatDateTime,
  formatStatus,
  getDashboardOperations,
} from "@/lib/dashboard-api";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { DashboardHeader } from "./dashboard-header";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  if (!isSupabaseConfigured) redirect("/login");
  const supabase = await createClient();
  const [{ data: claimsData }, { data: sessionData }] = await Promise.all([
    supabase.auth.getClaims(),
    supabase.auth.getSession(),
  ]);
  if (!claimsData?.claims || !sessionData.session?.access_token) redirect("/login");

  const email = typeof claimsData.claims.email === "string" ? claimsData.claims.email : "Supervisor";
  const operations = await getDashboardOperations(sessionData.session.access_token);
  const escalation = operations.find((operation) => operation.escalation);

  return (
    <main className="dashboard-shell">
      <DashboardHeader email={email} />
      <section className="dashboard-main">
        <div className="dashboard-title-row">
          <div>
            <h1>Operations</h1>
            <p>Live work from Tango&apos;s durable operation record.</p>
          </div>
          <p className="report-date">Last refreshed<br />{formatDateTime(new Date().toISOString())}</p>
        </div>

        {escalation?.escalation && (
          <section className="escalation-sheet" aria-labelledby="escalation-title">
            <div className="escalation-live"><span className="live-dot" aria-hidden="true" />Live call · awaiting supervisor</div>
            <div className="escalation-copy">
              <p className="operation-reference">{escalation.reference} · {escalation.clientName}</p>
              <h2 id="escalation-title">{escalation.escalation.reason}</h2>
              <p>Started {formatDateTime(escalation.escalation.startedAt)}</p>
            </div>
            <div className="escalation-action">
              <p>Active counterparty<br /><strong>{escalation.escalation.counterpartyName ?? "Not recorded"}</strong></p>
              <Link href={`/dashboard/operations/${escalation.reference}`}>Review operation</Link>
            </div>
          </section>
        )}

        <div className="operations-heading">
          <h2>Active operations <span>{operations.length}</span></h2>
          <p>Ordered by most recently updated.</p>
        </div>

        {operations.length > 0 ? (
          <div className="operations-table-wrap">
            <table className="operations-table">
              <thead>
                <tr><th>Operation</th><th>Route</th><th>Status</th><th>Next step</th><th>Updated</th></tr>
              </thead>
              <tbody>
                {operations.map((operation) => (
                  <tr key={operation.reference} className={operation.escalation ? "operation-row-escalated" : undefined}>
                    <td><Link href={`/dashboard/operations/${operation.reference}`}><strong>{operation.reference}</strong><span>{operation.clientName}</span></Link></td>
                    <td><span>{operation.pickupLocation ?? "Not recorded"}</span><strong>{operation.deliveryLocation ?? "Not recorded"}</strong></td>
                    <td><span className={`status-mark status-${operation.status.replaceAll("_", "-")}`}>{formatStatus(operation.status)}</span></td>
                    <td>{operation.nextStep}</td>
                    <td className="updated-time">{formatDateTime(operation.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <section className="dashboard-empty" aria-labelledby="empty-operations-title">
            <h2 id="empty-operations-title">No active operations.</h2>
            <p>When Tango records an authorised shipment request, it will appear here with its mandate and evidence trail.</p>
          </section>
        )}
      </section>
    </main>
  );
}
