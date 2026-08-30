import Link from "next/link";
import { notFound } from "next/navigation";

import {
  DashboardApiError,
  formatDateTime,
  formatMoney,
  formatStatus,
  formatWindow,
  getDashboardOperation,
  getDashboardHandoffs,
} from "@/lib/dashboard-api";
import { requireDashboardSession } from "@/lib/dashboard-session";
import { CommitmentEvidence } from "@/features/operation/commitment-evidence";
import { EscalationResolutionForm } from "@/features/operation/escalation-resolution-form";
import { HandoffOverlay } from "@/features/operation/handoff-overlay";
import { OperationCorrectionForm } from "@/features/operation/operation-correction-form";
import { OperationLiveUpdates } from "@/features/operation/operation-live-updates";
import { OperationTrace } from "@/features/operation/operation-trace";
import { DashboardHeader } from "../../dashboard-header";

export const dynamic = "force-dynamic";

export default async function OperationPage({ params }: { params: Promise<{ reference: string }> }) {
  const { accessToken, email } = await requireDashboardSession();
  const { reference } = await params;
  let operation;
  try {
    operation = await getDashboardOperation(reference, accessToken);
  } catch (error) {
    if (error instanceof DashboardApiError && error.status === 404) notFound();
    throw error;
  }
  const handoffs = await getDashboardHandoffs(accessToken);

  return (
    <main className="dashboard-shell">
      <DashboardHeader email={email} activeView="operations" />
      <HandoffOverlay handoffs={handoffs} />
      <article className="operation-detail">
        <Link href="/dashboard" className="back-to-operations">Back to active operations</Link>
        <header className="operation-detail-header">
          <div>
            <p className="operation-reference">{operation.reference}</p>
            <h1>Operation record</h1>
            <p className="operation-route">{operation.pickupLocation ?? "Pickup not recorded"} <span aria-hidden="true">→</span> {operation.deliveryLocation ?? "Delivery not recorded"}</p>
          </div>
          <div className="operation-status-block">
            <span className={`status-mark status-${operation.status.replaceAll("_", "-")}`}>{formatStatus(operation.status)}</span>
            <p>Updated {formatDateTime(operation.updatedAt)}</p>
          </div>
        </header>

        <section className="operation-command-strip" aria-label="Operation at a glance">
          <div><span>Client</span><strong>{operation.clientName}</strong></div>
          <div><span>Next action</span><strong>{operation.nextStep}</strong></div>
          <div><span>Mandate</span><strong>{operation.mandate ? `Version ${operation.mandate.version}` : "Awaiting authorization"}</strong></div>
          <div><span>Booking</span><strong>{operation.booking ? formatStatus(operation.booking.status) : "Not recorded"}</strong></div>
        </section>

        <OperationLiveUpdates reference={operation.reference} updatedAt={operation.updatedAt} />

        {operation.activeEscalation && (
          <section className="detail-escalation" aria-labelledby="live-decision-title">
            <div><span className="live-dot" aria-hidden="true" /> Human review · {formatStatus(operation.activeEscalation.handoffStatus)}</div>
            <div className="escalation-grid">
              <div>
                <h2 id="live-decision-title">{operation.activeEscalation.requestedAction}</h2>
                <p>{operation.activeEscalation.summary}</p>
              </div>
              <dl>
                <div><dt>Counterparty</dt><dd>{operation.activeEscalation.counterpartyName ?? "Not recorded"}</dd></div>
                <div><dt>Reason</dt><dd>{operation.activeEscalation.reason}</dd></div>
                <div><dt>Recipient</dt><dd>{operation.activeEscalation.recipient ? `${operation.activeEscalation.recipient.name} · ${formatStatus(operation.activeEscalation.recipient.role)}` : "Not configured"}</dd></div>
                <div><dt>Requested pickup</dt><dd>{formatWindow(operation.activeEscalation.requestedPickupWindow)}</dd></div>
                <div><dt>Action Window</dt><dd>{formatWindow(operation.activeEscalation.actionWindow)}</dd></div>
                <div><dt>Escalated</dt><dd>{formatDateTime(operation.activeEscalation.startedAt)}</dd></div>
              </dl>
            </div>
            {operation.activeEscalation.handoffStatusDetail && <p className="detail-escalation-status">{operation.activeEscalation.handoffStatusDetail}</p>}
            <details className="escalation-transcript">
              <summary>Conversation evidence <span>{operation.activeEscalation.transcript.length} recorded segment{operation.activeEscalation.transcript.length === 1 ? "" : "s"}</span></summary>
              {operation.activeEscalation.transcript.length > 0 ? <ol>
                {operation.activeEscalation.transcript.map((segment) => <li key={segment.id}>
                  <time dateTime={segment.recordedAt}>{formatDateTime(segment.recordedAt)}</time>
                  <strong>{segment.speaker === "caller" ? "Caller" : "Tango"}</strong>
                  <p>{segment.content}</p>
                </li>)}
              </ol> : <p>No completed transcript segments have been stored yet. The verified brief above remains the primary handoff record.</p>}
            </details>
            <EscalationResolutionForm escalationId={operation.activeEscalation.id} />
          </section>
        )}

        <div className="detail-grid">
          <section className="detail-section">
            <h2>Shipment details</h2>
            <dl className="facts-list">
              <div><dt>Container</dt><dd>{operation.containerType ?? "Not recorded"}</dd></div>
              <div><dt>Gross weight</dt><dd>{operation.grossWeightKg === null ? "Not recorded" : `${operation.grossWeightKg.toLocaleString("en-US")} kg`}</dd></div>
              <div><dt>Pickup</dt><dd>{operation.pickupLocation ?? "Not recorded"}</dd></div>
              <div><dt>Delivery</dt><dd>{operation.deliveryLocation ?? "Not recorded"}</dd></div>
              <div><dt>Empty return</dt><dd>{operation.emptyReturnDepot ?? "Not recorded"}</dd></div>
              <div><dt>Constraints</dt><dd>{operation.operationalConstraints.length > 0 ? operation.operationalConstraints.join(" · ") : "None recorded"}</dd></div>
              <div><dt>Cargo notes</dt><dd>{operation.cargoNotes ?? "None recorded"}</dd></div>
            </dl>
          </section>
          <section className="detail-section mandate-section">
            <h2>Authorization mandate {operation.mandate && <span>v{operation.mandate.version}</span>}</h2>
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

        {!operation.mandate && <OperationCorrectionForm operation={operation} />}

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
