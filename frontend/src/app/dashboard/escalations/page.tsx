import Link from "next/link";

import { formatDateTime, formatStatus, getDashboardEscalations, getDashboardHandoffs, getSavedViews } from "@/lib/dashboard-api";
import { requireDashboardSession } from "@/lib/dashboard-session";
import { EscalationResolutionForm } from "@/features/operation/escalation-resolution-form";
import { HandoffOverlay } from "@/features/operation/handoff-overlay";
import { LedgerPagination } from "@/features/operation/ledger-pagination";
import { DashboardLiveUpdates } from "@/features/operation/operation-live-updates";
import { SavedViewControls } from "@/features/operation/saved-view-controls";
import { DashboardHeader } from "../dashboard-header";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ page?: string | string[]; q?: string | string[]; status?: string | string[] }>;
function first(value: string | string[] | undefined): string { return Array.isArray(value) ? value[0] ?? "" : value ?? ""; }
function pageNumber(value: string): number { const page = Number(value); return Number.isInteger(page) && page > 0 ? page : 1; }

export default async function EscalationsPage({ searchParams }: { searchParams: SearchParams }) {
  const [{ accessToken, email }, query] = await Promise.all([requireDashboardSession(), searchParams]);
  const q = first(query.q).trim();
  const status = first(query.status);
  const page = pageNumber(first(query.page));
  const [escalations, handoffs, views] = await Promise.all([
    getDashboardEscalations(accessToken, { page, perPage: 25, q, status: status || undefined }),
    getDashboardHandoffs(accessToken),
    getSavedViews(accessToken, "escalations"),
  ]);
  const configuration = { q: q || undefined, status: status || undefined };

  return (
    <main className="dashboard-shell">
      <DashboardHeader email={email} activeView="escalations" />
      <HandoffOverlay handoffs={handoffs} />
      <section className="dashboard-main dispatch-spine">
        <header className="dashboard-title-row"><div><h1>Escalations</h1><p>Transferred conversations and their explicit, audited outcomes.</p></div><Link className="refresh-link" href="/dashboard/escalations">Reset ledger</Link></header>
        <DashboardLiveUpdates updatedAt={escalations.items[0]?.startedAt} />
        <section className="ledger-section" aria-labelledby="escalation-ledger-heading">
          <div className="operations-heading"><div><h2 id="escalation-ledger-heading">Escalation ledger <span>{escalations.pagination.total}</span></h2><p>Closing an escalation records a human decision; it does not alter call connection state.</p></div></div>
          <form className="operations-control-bar" action="/dashboard/escalations" method="get">
            <div className="operation-search"><label htmlFor="escalation-search">Search escalation records</label><input id="escalation-search" name="q" type="search" defaultValue={q} placeholder="Operation reference or reason" /><button type="submit">Search</button></div>
            <label className="ledger-select">State<select name="status" defaultValue={status}><option value="">All states</option><option value="active">Active</option><option value="resolved">Resolved</option><option value="failed">Failed</option></select></label>
          </form>
          <SavedViewControls scope="escalations" views={views} configuration={configuration} pathname="/dashboard/escalations" />
          {escalations.items.length > 0 ? <div className="escalation-ledger">
            {escalations.items.map((escalation) => (
              <article key={escalation.id} className={`escalation-ledger-row is-${escalation.status}`}>
                <header><span className={`status-mark status-${escalation.status.replaceAll("_", "-")}`}>{formatStatus(escalation.status)}</span><Link href={`/dashboard/operations/${escalation.operationReference}`}>{escalation.operationReference}</Link><time dateTime={escalation.startedAt}>{formatDateTime(escalation.startedAt)}</time></header>
                <div><h2>{escalation.clientName}</h2><p>{escalation.reason}</p><dl><div><dt>Counterparty</dt><dd>{escalation.counterpartyName ?? "Not recorded"}</dd></div><div><dt>Operation state</dt><dd>{formatStatus(escalation.operationStatus)}</dd></div>{escalation.resolvedAt && <div><dt>Closed</dt><dd>{formatDateTime(escalation.resolvedAt)}</dd></div>}</dl></div>
                {(escalation.status === "started" || escalation.status === "supervisor_joined") && <EscalationResolutionForm escalationId={escalation.id} />}
              </article>
            ))}
          </div> : <p className="section-empty-copy">No escalations match this view.</p>}
          <LedgerPagination pagination={escalations.pagination} pathname="/dashboard/escalations" values={configuration} />
        </section>
      </section>
    </main>
  );
}
