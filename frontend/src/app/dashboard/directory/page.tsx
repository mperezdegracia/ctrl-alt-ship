import Link from "next/link";

import { getDashboardHandoffs, getDirectoryEntries, getHandoffRecipients, type DirectoryEntry, type HandoffRecipient } from "@/lib/dashboard-api";
import { requireDashboardSession } from "@/lib/dashboard-session";
import { DirectoryManager } from "@/features/directory/directory-manager";
import { HandoffRecipientManager } from "@/features/directory/handoff-recipient-manager";
import { HandoffOverlay } from "@/features/operation/handoff-overlay";
import { LedgerPagination } from "@/features/operation/ledger-pagination";
import { DashboardLiveUpdates } from "@/features/operation/operation-live-updates";
import { DashboardHeader } from "../dashboard-header";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ page?: string | string[]; q?: string | string[]; kind?: string | string[]; active?: string | string[] }>;
function first(value: string | string[] | undefined): string { return Array.isArray(value) ? value[0] ?? "" : value ?? ""; }
function pageNumber(value: string): number { const page = Number(value); return Number.isInteger(page) && page > 0 ? page : 1; }

export default async function DirectoryPage({ searchParams }: { searchParams: SearchParams }) {
  const [{ accessToken, email }, query] = await Promise.all([requireDashboardSession(), searchParams]);
  const requestedKind = first(query.kind);
  const kind = requestedKind === "providers" || requestedKind === "recipients" ? requestedKind : "contacts";
  const q = first(query.q).trim();
  const active = first(query.active);
  const page = pageNumber(first(query.page));
  const [directory, handoffs] = await Promise.all([
    kind === "recipients"
      ? getHandoffRecipients(accessToken, { page, perPage: 50, q, active: active === "true" ? true : active === "false" ? false : undefined })
      : getDirectoryEntries(accessToken, kind, { page, perPage: 50, q, active: active === "true" ? true : active === "false" ? false : undefined }),
    getDashboardHandoffs(accessToken),
  ]);
  const baseParams = new URLSearchParams({ kind });
  const contactsHref = "/dashboard/directory?kind=contacts";
  const providersHref = "/dashboard/directory?kind=providers";
  const recipientsHref = "/dashboard/directory?kind=recipients";
  const configuration = { kind, q: q || undefined, active: active || undefined };

  return (
    <main className="dashboard-shell">
      <DashboardHeader email={email} activeView="directory" />
      <HandoffOverlay handoffs={handoffs} />
      <section className="dashboard-main dispatch-spine">
        <header className="dashboard-title-row"><div><h1>Directory</h1><p>Editable counterparty and human-routing records. Deactivation preserves the durable history.</p></div><Link className="refresh-link" href={`/dashboard/directory?${baseParams.toString()}`}>Reset directory</Link></header>
        <DashboardLiveUpdates updatedAt={directory.items[0]?.updatedAt} />
        <section className="ledger-section" aria-labelledby="directory-heading">
          <div className="operations-heading"><div><h2 id="directory-heading">{kind === "contacts" ? "Contacts" : kind === "providers" ? "Providers" : "Handoff recipients"} <span>{directory.pagination.total}</span></h2><p>{kind === "recipients" ? "Outbound human-routing records remain separate from inbound caller identities." : "Counterparty phone numbers stay unique across both registers."}</p></div><div className="system-view-tabs"><Link href={contactsHref} aria-current={kind === "contacts" ? "page" : undefined}>Contacts</Link><Link href={providersHref} aria-current={kind === "providers" ? "page" : undefined}>Providers</Link><Link href={recipientsHref} aria-current={kind === "recipients" ? "page" : undefined}>Handoff</Link></div></div>
          <form className="operations-control-bar" action="/dashboard/directory" method="get">
            <input type="hidden" name="kind" value={kind} />
            <div className="operation-search"><label htmlFor="directory-search">Search {kind === "recipients" ? "handoff recipients" : kind}</label><input id="directory-search" name="q" type="search" defaultValue={q} placeholder={kind === "recipients" ? "Name, phone or role" : "Name, phone or email"} /><button type="submit">Search</button></div>
            <label className="ledger-select">State<select name="active" defaultValue={active}><option value="">All records</option><option value="true">Active</option><option value="false">Inactive</option></select></label>
          </form>
          {kind === "recipients" ? <HandoffRecipientManager recipients={directory.items as HandoffRecipient[]} /> : <DirectoryManager kind={kind} entries={directory.items as DirectoryEntry[]} />}
          <LedgerPagination pagination={directory.pagination} pathname="/dashboard/directory" values={configuration} />
        </section>
      </section>
    </main>
  );
}
