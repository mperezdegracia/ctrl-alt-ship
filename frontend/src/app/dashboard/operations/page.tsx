import Link from "next/link";

import { formatStatus, getDashboardHandoffs, getDashboardOperations } from "@/lib/dashboard-api";
import { requireDashboardSession } from "@/lib/dashboard-session";
import { HandoffOverlay } from "@/features/operation/handoff-overlay";
import { LedgerPagination } from "@/features/operation/ledger-pagination";
import { DashboardLiveUpdates } from "@/features/operation/operation-live-updates";
import { OperationsRegister } from "@/features/operation/operations-register";
import { DashboardHeader } from "../dashboard-header";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ page?: string | string[]; q?: string | string[]; status?: string | string[]; attention?: string | string[] }>;

function first(value: string | string[] | undefined): string { return Array.isArray(value) ? value[0] ?? "" : value ?? ""; }
function pageNumber(value: string): number { const page = Number(value); return Number.isInteger(page) && page > 0 ? page : 1; }

const statusOptions = ["collecting_details", "sourcing", "quotes_received", "quote_selected", "booking_pending", "booking_confirmed", "notifications_sent", "needs_follow_up"];

export default async function OperationsPage({ searchParams }: { searchParams: SearchParams }) {
  const [{ accessToken, email }, query] = await Promise.all([requireDashboardSession(), searchParams]);
  const q = first(query.q).trim();
  const status = first(query.status);
  const attention = first(query.attention) === "true";
  const page = pageNumber(first(query.page));
  const [operations, handoffs] = await Promise.all([
    getDashboardOperations(accessToken, { page, perPage: 50, q, status: status || undefined, attention }),
    getDashboardHandoffs(accessToken),
  ]);
  const configuration = { q: q || undefined, status: status || undefined, attention: attention ? "true" : undefined };

  return (
    <main className="dashboard-shell">
      <DashboardHeader email={email} activeView="operations" />
      <HandoffOverlay handoffs={handoffs} />
      <section className="dashboard-main dispatch-spine operations-screen">
        <header className="dashboard-title-row"><div><h1>Operations</h1><p>Every active shipment record, without replacing its evidence trail.</p></div><Link className="refresh-link" href="/dashboard/operations">Reset register</Link></header>
        <DashboardLiveUpdates updatedAt={operations.items[0]?.updatedAt} />
        <section className="ledger-section" aria-labelledby="operations-register-heading">
          <div className="operations-heading operations-heading-with-actions"><div><h2 id="operations-register-heading">Operational register <span>{operations.pagination.total}</span></h2><p>Search and filters are evaluated by the operations API before paging.</p></div><label className="ledger-check operations-attention"><input form="operations-filter-form" name="attention" value="true" type="checkbox" defaultChecked={attention} />Needs attention</label></div>
          <form id="operations-filter-form" className="operations-control-bar operations-control-bar-expanded" action="/dashboard/operations" method="get">
            <div className="operation-search"><label htmlFor="operations-search">Search operation records</label><input id="operations-search" name="q" type="search" defaultValue={q} placeholder="Reference, client or route" /></div>
            <label className="ledger-select">Status<select name="status" defaultValue={status}><option value="">All active states</option>{statusOptions.map((option) => <option key={option} value={option}>{formatStatus(option)}</option>)}</select></label>
            <button className="operations-search-submit" type="submit">Search</button>
          </form>
          <OperationsRegister operations={operations.items} />
          <LedgerPagination pagination={operations.pagination} pathname="/dashboard/operations" values={configuration} />
        </section>
      </section>
    </main>
  );
}
