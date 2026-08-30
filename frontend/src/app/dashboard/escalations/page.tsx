import Link from "next/link";

import { formatStatus, getDashboardEscalations, getDashboardHandoffs } from "@/lib/dashboard-api";
import { requireDashboardSession } from "@/lib/dashboard-session";
import { LocalDateTime } from "@/components/local-time";
import { EscalationResolutionForm } from "@/features/operation/escalation-resolution-form";
import { HandoffOverlay } from "@/features/operation/handoff-overlay";
import { LedgerPagination } from "@/features/operation/ledger-pagination";
import { DashboardLiveUpdates } from "@/features/operation/operation-live-updates";
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
  const [escalations, handoffs] = await Promise.all([
    getDashboardEscalations(accessToken, { page, perPage: 25, q, status: status || undefined }),
    getDashboardHandoffs(accessToken),
  ]);
  const configuration = { q: q || undefined, status: status || undefined };

  return (
    <main className="dashboard-shell">
      <DashboardHeader email={email} activeView="escalations" />
      <HandoffOverlay handoffs={handoffs} />
      <section className="dashboard-main dispatch-spine escalation-screen">
        <header className="dashboard-title-row"><div><h1>Escalations</h1><p>Human reviews and their explicit, audited outcomes.</p></div><Link className="refresh-link" href="/dashboard/escalations">Reset ledger</Link></header>
        <DashboardLiveUpdates updatedAt={escalations.items[0]?.startedAt} />
        <section className="ledger-section" aria-labelledby="escalation-ledger-heading">
          <div className="operations-heading"><div><h2 id="escalation-ledger-heading">Open decisions <span>{escalations.pagination.total}</span></h2><p>Resolve only after confirming the durable operation record.</p></div></div>
          <form className="operations-control-bar escalation-control-bar" action="/dashboard/escalations" method="get">
            <div className="operation-search"><label htmlFor="escalation-search">Search escalation records</label><input id="escalation-search" name="q" type="search" defaultValue={q} placeholder="Operation reference or reason" /></div>
            <label className="ledger-select">State<select name="status" defaultValue={status}><option value="">All states</option><option value="active">Active</option><option value="resolved">Resolved</option><option value="failed">Failed</option></select></label>
            <button className="escalation-search-submit" type="submit">Search</button>
          </form>
          {escalations.items.length > 0 ? <div className="escalation-ledger">
            {escalations.items.map((escalation) => (
              <article key={escalation.id} className={`escalation-ledger-row is-${escalation.status} is-handoff-${escalation.handoffStatus}`}>
                <header><span className={`status-mark status-${escalation.status.replaceAll("_", "-")}`}>{formatStatus(escalation.status)}</span><Link href={`/dashboard/operations/${escalation.operationReference}`}>{escalation.operationReference}</Link><LocalDateTime value={escalation.startedAt} />{(escalation.status === "started" || escalation.status === "supervisor_joined") && <EscalationResolutionForm escalationId={escalation.id} />}</header>
                <div><h2>{escalation.requestedAction}</h2><p>{escalation.summary}</p><dl><div><dt>Counterparty</dt><dd>{escalation.counterpartyName ?? "Not recorded"}</dd></div><div><dt>Reason</dt><dd>{escalation.reason}</dd></div><div><dt>Handoff</dt><dd>{formatStatus(escalation.handoffStatus)}</dd></div><div><dt>Recipient</dt><dd>{escalation.recipient ? `${escalation.recipient.name} · ${formatStatus(escalation.recipient.role)}` : "Not configured"}</dd></div><div><dt>Operation state</dt><dd>{formatStatus(escalation.operationStatus)}</dd></div>{escalation.resolvedAt && <div><dt>Closed</dt><dd><LocalDateTime value={escalation.resolvedAt} /></dd></div>}</dl>{escalation.handoffStatusDetail && <p className="escalation-handoff-note">{escalation.handoffStatusDetail}</p>}</div>
              </article>
            ))}
          </div> : <p className="section-empty-copy">No escalations match this view.</p>}
          <LedgerPagination pagination={escalations.pagination} pathname="/dashboard/escalations" values={configuration} />
        </section>
      </section>
    </main>
  );
}
