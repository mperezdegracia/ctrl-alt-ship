import Link from "next/link";

import { getDashboardHandoffs, getDashboardOperations } from "@/lib/dashboard-api";
import { requireDashboardSession } from "@/lib/dashboard-session";
import { HandoffOverlay } from "@/features/operation/handoff-overlay";
import { LedgerPagination } from "@/features/operation/ledger-pagination";
import { OperationsRegister } from "@/features/operation/operations-register";
import { DashboardLiveUpdates } from "@/features/operation/operation-live-updates";
import { DashboardHeader } from "./dashboard-header";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ page?: string | string[]; q?: string | string[]; attention?: string | string[] }>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function pageNumber(value: string): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export default async function ControlRoomPage({ searchParams }: { searchParams: SearchParams }) {
  const [{ accessToken, email }, query] = await Promise.all([requireDashboardSession(), searchParams]);
  const q = first(query.q).trim();
  const attention = first(query.attention) === "true";
  const page = pageNumber(first(query.page));
  const [operations, handoffs] = await Promise.all([
    getDashboardOperations(accessToken, { page, perPage: 25, q, attention }),
    getDashboardHandoffs(accessToken),
  ]);
  const current = new URLSearchParams();
  if (q) current.set("q", q);
  if (attention) current.set("attention", "true");
  const clearHref = current.size > 0 ? `/dashboard?${current.toString()}` : "/dashboard";

  return (
    <main className="dashboard-shell">
      <DashboardHeader email={email} activeView="control-room" />
      <HandoffOverlay handoffs={handoffs} />
      <section className="dashboard-main dispatch-spine">
        <header className="dashboard-title-row">
          <div><h1>Control room</h1><p>Live transfers and the records that need operator attention.</p></div>
          <Link className="refresh-link" href={clearHref}>Refresh record</Link>
        </header>

        <DashboardLiveUpdates updatedAt={operations.items[0]?.updatedAt} />

        {handoffs.length > 0 && (
          <section className="handoff-register" aria-labelledby="handoff-register-heading">
            <div className="section-heading-row"><div><h2 id="handoff-register-heading">Transferred calls</h2><p>Calls move automatically; open their verified context without controlling the connection.</p></div></div>
            <ol>
              {handoffs.map((handoff) => <li key={handoff.id}><span><i aria-hidden="true" />{handoff.operationReference}</span><strong>{handoff.clientName}</strong><p>{handoff.reason}</p><Link href={`/dashboard/operations/${handoff.operationReference}`}>Open operation</Link></li>)}
            </ol>
          </section>
        )}

        <section className="ledger-section" aria-labelledby="control-register-heading">
          <div className="operations-heading">
            <div><h2 id="control-register-heading">{attention ? "Attention queue" : "Current operations"} <span>{operations.pagination.total}</span></h2><p>Server-filtered and ordered by latest durable change.</p></div>
            <div className="system-view-tabs"><Link href="/dashboard" aria-current={!attention ? "page" : undefined}>All active</Link><Link href="/dashboard?attention=true" aria-current={attention ? "page" : undefined}>Needs attention</Link></div>
          </div>
          <form className="operation-search" action="/dashboard" method="get">
            {attention && <input type="hidden" name="attention" value="true" />}
            <label htmlFor="control-room-search">Search operation records</label>
            <input id="control-room-search" name="q" type="search" defaultValue={q} placeholder="Reference, client or route" />
            <button type="submit">Search</button>
          </form>
          <OperationsRegister operations={operations.items} />
          <LedgerPagination pagination={operations.pagination} pathname="/dashboard" values={{ q, attention: attention ? "true" : undefined }} />
        </section>
      </section>
    </main>
  );
}
