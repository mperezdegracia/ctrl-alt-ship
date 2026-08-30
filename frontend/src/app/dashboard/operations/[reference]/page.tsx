import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getOperation, getOperationDossier } from "@/lib/mock-operations";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { CommitmentEvidence } from "@/features/operation/commitment-evidence";
import { DashboardHeader } from "../../dashboard-header";

export const dynamic = "force-dynamic";

export default async function OperationPage({ params }: { params: Promise<{ reference: string }> }) {
  if (!isSupabaseConfigured) redirect("/login");
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData) redirect("/login");

  const { reference } = await params;
  const [operation, dossier] = await Promise.all([getOperation(reference), getOperationDossier(reference)]);
  if (!operation) notFound();
  const email = typeof claimsData.claims.email === "string" ? claimsData.claims.email : "Supervisor";

  return (
    <main className="dashboard-shell">
      <DashboardHeader email={email} />
      <article className="operation-detail">
        <Link href="/dashboard" className="back-to-operations">Back to active operations</Link>
        <header className="operation-detail-header">
          <div>
            <p className="operation-reference">{operation.reference}</p>
            <h1>{operation.client}</h1>
            <p className="operation-route">{operation.origin} <span aria-hidden="true">→</span> {operation.destination}</p>
          </div>
          <div className="operation-status-block">
            <span className={`status-mark status-${operation.status.toLowerCase().replaceAll(" ", "-")}`}>{operation.status}</span>
            <p>Updated {operation.updated}</p>
          </div>
        </header>

        {dossier ? (
          <>
            <section className="detail-escalation" aria-labelledby="live-decision-title">
              <div><span className="live-dot" aria-hidden="true" /> Live call · {dossier.escalation.counterparty}</div>
              <div className="escalation-grid">
                <div>
                  <h2 id="live-decision-title">Pickup reschedule needs your review.</h2>
                  <p>The provider proposed a change outside the Action Window. Tango kept the booking intact and escalated instead of making an unsupported promise.</p>
                </div>
                <dl>
                  <div><dt>Requested pickup</dt><dd>{dossier.escalation.requested}</dd></div>
                  <div><dt>Action Window</dt><dd>{dossier.escalation.authorized}</dd></div>
                  <div><dt>Escalated</dt><dd>{dossier.escalation.startedAt}</dd></div>
                </dl>
              </div>
            </section>

            <div className="detail-grid">
              <section className="detail-section">
                <h2>Operation</h2>
                <dl className="facts-list">
                  <div><dt>Container</dt><dd>{operation.container} · {operation.containerType}</dd></div>
                  <div><dt>Gross weight</dt><dd>{operation.weight}</dd></div>
                  <div><dt>Pickup</dt><dd>{operation.origin}</dd></div>
                  <div><dt>Delivery</dt><dd>{operation.destination}</dd></div>
                  <div><dt>Empty return</dt><dd>{operation.emptyReturn}</dd></div>
                </dl>
              </section>
              <section className="detail-section mandate-section">
                <h2>Current Mandate <span>{dossier.mandate.version}</span></h2>
                <dl className="facts-list">
                  <div><dt>Maximum price</dt><dd>{dossier.mandate.priceCap}</dd></div>
                  <div><dt>Payment term</dt><dd>{dossier.mandate.paymentTerm}</dd></div>
                  <div><dt>Action Window</dt><dd>{dossier.mandate.actionWindow}</dd></div>
                  <div><dt>Constraints</dt><dd>{dossier.mandate.constraints}</dd></div>
                </dl>
              </section>
            </div>

            <section className="detail-section booking-section">
              <div className="section-heading-row"><h2>Current Booking</h2><p>Confirmed · {dossier.booking.reference}</p></div>
              <div className="booking-summary">
                <div><span>Provider</span><strong>{dossier.booking.provider}</strong></div>
                <div><span>Confirmed price</span><strong>{dossier.booking.confirmedPrice}</strong></div>
                <div><span>Current pickup</span><strong>{dossier.booking.pickup}</strong><small>Originally {dossier.booking.previousPickup}</small></div>
              </div>
              <div className="selection-rationale"><span>Why this provider</span><p>{dossier.selectionReason}</p></div>
              <div className="quote-comparison">
                <p>Relevant quotes</p>
                {dossier.quotes.map((quote) => (
                  <div key={quote.provider} className={quote.selected ? "is-selected" : undefined}>
                    <span>{quote.provider}{quote.selected ? " · selected" : ""}</span>
                    <strong>{quote.price}</strong>
                    <em>{quote.verdict}</em>
                  </div>
                ))}
              </div>
            </section>

            <CommitmentEvidence commitments={dossier.commitments} />
          </>
        ) : (
          <section className="detail-section dossier-pending">
            <p className="section-label">Evidence intake</p>
            <h2>The operation record is waiting for its first verified commitment.</h2>
            <p>Shipment details are available above. The mandate, quotes, booking rationale and call evidence will appear here as Tango records them.</p>
          </section>
        )}
      </article>
    </main>
  );
}
