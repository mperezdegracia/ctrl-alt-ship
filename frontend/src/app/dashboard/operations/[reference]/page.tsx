import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import {
  DashboardApiError,
  formatDateTime,
  formatMoney,
  formatStatus,
  formatWindow,
  getDashboardOperation,
} from "@/lib/dashboard-api";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { CommitmentEvidence } from "@/features/operation/commitment-evidence";
import { OperationTrace } from "@/features/operation/operation-trace";
import { DashboardHeader } from "../../dashboard-header";

export const dynamic = "force-dynamic";

export default async function OperationPage({ params }: { params: Promise<{ reference: string }> }) {
  if (!isSupabaseConfigured) redirect("/login");
  const supabase = await createClient();
  const [{ data: claimsData }, { data: sessionData }] = await Promise.all([
    supabase.auth.getClaims(),
    supabase.auth.getSession(),
  ]);
  if (!claimsData?.claims || !sessionData.session?.access_token) redirect("/login");

  const { reference } = await params;
  let operation;
  try {
    operation = await getDashboardOperation(reference, sessionData.session.access_token);
  } catch (error) {
    if (error instanceof DashboardApiError && error.status === 404) notFound();
    throw error;
  }
  const email = typeof claimsData.claims.email === "string" ? claimsData.claims.email : "Supervisor";

  return (
    <main className="dashboard-shell">
      <DashboardHeader email={email} activeView="operations" />
      <article className="operation-detail">
        <Link href="/dashboard" className="back-to-operations">Back to active operations</Link>
        <header className="operation-detail-header">
          <div>
            <p className="operation-reference">{operation.reference}</p>
            <h1>{operation.clientName}</h1>
            <p className="operation-route">{operation.pickupLocation ?? "Pickup not recorded"} <span aria-hidden="true">→</span> {operation.deliveryLocation ?? "Delivery not recorded"}</p>
          </div>
          <div className="operation-status-block">
            <span className={`status-mark status-${operation.status.replaceAll("_", "-")}`}>{formatStatus(operation.status)}</span>
            <p>Updated {formatDateTime(operation.updatedAt)}</p>
          </div>
        </header>

        {operation.activeEscalation && (
          <section className="detail-escalation" aria-labelledby="live-decision-title">
            <div><span className="live-dot" aria-hidden="true" /> Live call · {operation.activeEscalation.counterpartyName ?? "Counterparty not recorded"}</div>
            <div className="escalation-grid">
              <div>
                <h2 id="live-decision-title">Supervisor review is required.</h2>
                <p>{operation.activeEscalation.reason}</p>
              </div>
              <dl>
                <div><dt>Requested pickup</dt><dd>{formatWindow(operation.activeEscalation.requestedPickupWindow)}</dd></div>
                <div><dt>Action Window</dt><dd>{formatWindow(operation.activeEscalation.actionWindow)}</dd></div>
                <div><dt>Escalated</dt><dd>{formatDateTime(operation.activeEscalation.startedAt)}</dd></div>
              </dl>
            </div>
          </section>
        )}

        <div className="detail-grid">
          <section className="detail-section">
            <h2>Operation</h2>
            <dl className="facts-list">
              <div><dt>Container</dt><dd>{operation.containerType ?? "Not recorded"}</dd></div>
              <div><dt>Gross weight</dt><dd>{operation.grossWeightKg === null ? "Not recorded" : `${operation.grossWeightKg.toLocaleString("en-US")} kg`}</dd></div>
              <div><dt>Pickup</dt><dd>{operation.pickupLocation ?? "Not recorded"}</dd></div>
              <div><dt>Delivery</dt><dd>{operation.deliveryLocation ?? "Not recorded"}</dd></div>
              <div><dt>Empty return</dt><dd>{operation.emptyReturnDepot ?? "Not recorded"}</dd></div>
            </dl>
          </section>
          <section className="detail-section mandate-section">
            <h2>Current Mandate {operation.mandate && <span>v{operation.mandate.version}</span>}</h2>
            {operation.mandate ? (
              <dl className="facts-list">
                <div><dt>Maximum price</dt><dd>{formatMoney(operation.mandate.priceCap, operation.mandate.currency)}</dd></div>
                <div><dt>Payment term</dt><dd>{operation.mandate.paymentTermDays} days from invoice date</dd></div>
                <div><dt>Action Window</dt><dd>{formatWindow(operation.mandate.actionWindows[0] ?? null)}</dd></div>
                <div><dt>Constraints</dt><dd>{operation.mandate.constraints.length > 0 ? operation.mandate.constraints.join(" · ") : "None recorded"}</dd></div>
              </dl>
            ) : (
              <p className="section-empty-copy">No mandate has been confirmed for this operation.</p>
            )}
          </section>
        </div>

        <section className="detail-section booking-section">
          <div className="section-heading-row"><h2>Current Booking</h2>{operation.booking && <p>{formatStatus(operation.booking.status)} · {operation.booking.reference ?? "Reference pending"}</p>}</div>
          {operation.booking ? (
            <div className="booking-summary">
              <div><span>Provider</span><strong>{operation.booking.providerName ?? "Not recorded"}</strong></div>
              <div><span>Confirmed price</span><strong>{operation.booking.confirmedPrice === null || !operation.booking.currency ? "Not recorded" : formatMoney(operation.booking.confirmedPrice, operation.booking.currency)}</strong></div>
              <div><span>Pickup window</span><strong>{formatWindow(operation.booking.pickupWindow)}</strong></div>
            </div>
          ) : (
            <p className="section-empty-copy">No active booking has been recorded.</p>
          )}

          {operation.selectionReason && <div className="selection-rationale"><span>Why this provider</span><p>{operation.selectionReason}</p></div>}

          {operation.quotes.length > 0 && (
            <div className="quote-comparison">
              <p>Relevant quotes</p>
              {operation.quotes.map((quote) => (
                <div key={quote.id} className={quote.selected ? "is-selected" : undefined}>
                  <span>{quote.providerName}{quote.selected ? " · selected" : ""}</span>
                  <strong>{quote.priceMin === quote.priceMax ? formatMoney(quote.priceMax, quote.currency) : `${formatMoney(quote.priceMin, quote.currency)}–${formatMoney(quote.priceMax, quote.currency)}`}</strong>
                  <em>{formatStatus(quote.verdict)}</em>
                </div>
              ))}
            </div>
          )}
        </section>

        <OperationTrace trace={operation.trace} />

        {operation.commitments.length > 0 ? (
          <CommitmentEvidence commitments={operation.commitments} />
        ) : (
          <section className="detail-section dossier-pending">
            <h2>No commitments yet.</h2>
            <p>A commitment appears here only after Tango records a server-validated quote, booking or reschedule with its call evidence.</p>
          </section>
        )}
      </article>
    </main>
  );
}
