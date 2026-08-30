import Link from "next/link";
import { redirect } from "next/navigation";

import {
  formatDateTime,
  formatStatus,
  getDashboardOperations,
} from "@/lib/dashboard-api";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { DashboardLiveUpdates } from "@/features/operation/operation-live-updates";
import { DashboardHeader } from "./dashboard-header";

export const dynamic = "force-dynamic";

type DashboardPageSearchParams = Promise<{ filter?: string | string[]; q?: string | string[] }>;

function firstQueryValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function statusFilterHref(status: string): string {
  return `/dashboard?filter=status:${encodeURIComponent(status)}`;
}

export default async function DashboardPage({ searchParams }: { searchParams: DashboardPageSearchParams }) {
  if (!isSupabaseConfigured) redirect("/login");
  const query = await searchParams;
  const supabase = await createClient();
  const [{ data: claimsData }, { data: sessionData }] = await Promise.all([
    supabase.auth.getClaims(),
    supabase.auth.getSession(),
  ]);
  if (!claimsData?.claims || !sessionData.session?.access_token) redirect("/login");

  const email = typeof claimsData.claims.email === "string" ? claimsData.claims.email : "Supervisor";
  const operations = await getDashboardOperations(sessionData.session.access_token);
  const selectedFilter = firstQueryValue(query.filter);
  const search = firstQueryValue(query.q).trim();
  const attentionOperations = operations.filter((operation) => operation.escalation || operation.status === "needs_follow_up");
  const matchingFilter = selectedFilter === "attention"
    ? attentionOperations
    : selectedFilter.startsWith("status:")
      ? operations.filter((operation) => operation.status === selectedFilter.slice("status:".length))
      : operations;
  const visibleOperations = search
    ? matchingFilter.filter((operation) => [
      operation.reference,
      operation.clientName,
      operation.pickupLocation,
      operation.deliveryLocation,
      operation.status,
    ].filter((value): value is string => Boolean(value)).join(" ").toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    : matchingFilter;
  const escalation = operations.find((operation) => operation.escalation);
  const statuses = [...new Set(operations.map((operation) => operation.status))];
  const activeView = selectedFilter === "attention" ? "attention" : "operations";
  const currentHref = new URLSearchParams();
  if (selectedFilter) currentHref.set("filter", selectedFilter);
  if (search) currentHref.set("q", search);
  const refreshHref = currentHref.size > 0 ? `/dashboard?${currentHref.toString()}` : "/dashboard";

  return (
    <main className="dashboard-shell">
      <DashboardHeader email={email} activeView={activeView} />
      <section className="dashboard-main">
        <div className="dashboard-title-row">
          <div>
            <h1>Operations</h1>
            <p>Live work from Tango&apos;s durable operation record.</p>
          </div>
          <p className="report-date">Read at request time<br />{formatDateTime(new Date().toISOString())}</p>
        </div>

        {operations[0] && <DashboardLiveUpdates updatedAt={operations[0].updatedAt} />}

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

        <div className="operations-heading operations-heading-with-actions">
          <div>
            <h2>{selectedFilter === "attention" ? "Attention queue" : "Active operations"} <span>{visibleOperations.length}</span></h2>
            <p>{visibleOperations.length === operations.length ? "Ordered by most recently updated." : `Showing ${visibleOperations.length} of ${operations.length} live operations.`}</p>
          </div>
          <Link className="refresh-link" href={refreshHref}>Refresh record</Link>
        </div>

        {operations.length > 0 && (
          <section className="operations-control-bar" aria-label="Filter operations">
            <div className="operations-filters" aria-label="Saved operation views">
              <Link href="/dashboard" aria-current={!selectedFilter ? "page" : undefined}>All <span>{operations.length}</span></Link>
              <Link href="/dashboard?filter=attention" aria-current={selectedFilter === "attention" ? "page" : undefined}>Attention <span>{attentionOperations.length}</span></Link>
              {statuses.map((status) => (
                <Link key={status} href={statusFilterHref(status)} aria-current={selectedFilter === `status:${status}` ? "page" : undefined}>
                  {formatStatus(status)} <span>{operations.filter((operation) => operation.status === status).length}</span>
                </Link>
              ))}
            </div>
            <form className="operation-search" action="/dashboard" method="get">
              {selectedFilter && <input type="hidden" name="filter" value={selectedFilter} />}
              <label htmlFor="operation-search">Search live record</label>
              <input id="operation-search" name="q" defaultValue={search} placeholder="Reference, client or route" type="search" />
              <button type="submit">Find</button>
            </form>
          </section>
        )}

        {visibleOperations.length > 0 ? (
          <div className="operations-table-wrap">
            <table className="operations-table">
              <thead>
                <tr><th>Operation</th><th>Route</th><th>Status</th><th>Next step</th><th>Updated</th></tr>
              </thead>
              <tbody>
                {visibleOperations.map((operation) => (
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
        ) : operations.length === 0 ? (
          <section className="dashboard-empty" aria-labelledby="empty-operations-title">
            <h2 id="empty-operations-title">No active operations.</h2>
            <p>When Tango records an authorised shipment request, it will appear here with its mandate and evidence trail.</p>
          </section>
        ) : (
          <section className="dashboard-empty dashboard-filter-empty" aria-labelledby="empty-filter-title">
            <p className="section-label">Live record search</p>
            <h2 id="empty-filter-title">No operations match this view.</h2>
            <p>Change the saved view or clear the search to return to every active operation.</p>
            <Link href="/dashboard">Clear filters</Link>
          </section>
        )}
      </section>
    </main>
  );
}
