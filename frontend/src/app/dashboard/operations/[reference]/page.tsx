import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getOperation } from "@/lib/mock-operations";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { DashboardHeader } from "../../dashboard-header";

export const dynamic = "force-dynamic";

export default async function OperationPage({ params }: { params: Promise<{ reference: string }> }) {
  if (!isSupabaseConfigured) redirect("/login");
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData) redirect("/login");

  const { reference } = await params;
  const operation = await getOperation(reference);
  if (!operation) notFound();
  const email = typeof claimsData.claims.email === "string" ? claimsData.claims.email : "Supervisor";

  return (
    <main className="dashboard-shell">
      <DashboardHeader email={email} />
      <article className="operation-detail">
        <Link href="/dashboard" className="back-to-operations">Back to active operations</Link>
        <header className="operation-detail-header">
          <div><p className="operation-reference">{operation.reference}</p><h1>{operation.client}</h1></div>
          <span className="status-mark status-needs-follow-up">Needs follow-up</span>
        </header>

        <section className="detail-escalation" aria-labelledby="live-decision-title">
          <div><span className="live-dot" aria-hidden="true" /> Live call · Transporte Sur</div>
          <h2 id="live-decision-title">Pickup reschedule needs your review.</h2>
          <p>The provider proposes Tue 02 Sep, 16:00–18:00. That time sits outside the current Action Window, so Tango paused the conversation and escalated it.</p>
          <dl><div><dt>Requested pickup</dt><dd>Tue 02 Sep · 16:00–18:00</dd></div><div><dt>Action Window</dt><dd>Mon 01 Sep · 08:00–14:00</dd></div><div><dt>Escalation started</dt><dd>14:40 ART · 2 min ago</dd></div></dl>
        </section>

        <div className="detail-grid">
          <section className="detail-section"><h2>Operation</h2><dl className="facts-list"><div><dt>Container</dt><dd>{operation.container} · {operation.containerType}</dd></div><div><dt>Gross weight</dt><dd>{operation.weight}</dd></div><div><dt>Pickup</dt><dd>{operation.origin}</dd></div><div><dt>Delivery</dt><dd>{operation.destination}</dd></div><div><dt>Empty return</dt><dd>{operation.emptyReturn}</dd></div></dl></section>
          <section className="detail-section mandate-section"><h2>Current Mandate <span>v3</span></h2><dl className="facts-list"><div><dt>Maximum price</dt><dd>ARS 950,000</dd></div><div><dt>Payment term</dt><dd>30 days from invoice date</dd></div><div><dt>Action Window</dt><dd>Mon 01 Sep · 08:00–14:00</dd></div><div><dt>Operational constraints</dt><dd>Delivery appointment required · Non-hazardous cargo</dd></div></dl></section>
        </div>

        <section className="detail-section booking-section"><div className="section-heading-row"><h2>Current Booking</h2><p>Confirmed · BK-49218</p></div><div className="booking-summary"><div><span>Provider</span><strong>Transporte Sur</strong></div><div><span>Confirmed price</span><strong>ARS 908,000</strong></div><div><span>Original pickup</span><strong>Mon 01 Sep · 10:00–12:00</strong></div></div><div className="quote-comparison"><p>Relevant quotes</p><div><span>Transporte Sur · selected</span><strong>ARS 908,000</strong><em>Within Mandate</em></div><div><span>Logística Ruta 3</span><strong>ARS 932,000</strong><em>Within Mandate</em></div><div><span>Fletes del Plata</span><strong>—</strong><em>Request expired</em></div></div></section>

        <section className="detail-section commitments-section"><h2>Commitments</h2><ol className="commitment-timeline"><li><time>14:40</time><div><strong>Escalation started</strong><span>Provider requested a reschedule outside the Action Window.</span><small>Call checkpoint 08:14</small></div></li><li><time>11:18</time><div><strong>Booking confirmed</strong><span>Transporte Sur confirmed pickup for Mon 01 Sep, 10:00–12:00.</span><small>Call checkpoint 05:42</small></div></li><li><time>10:54</time><div><strong>Quote accepted</strong><span>ARS 908,000 evaluated within Mandate v3.</span><small>Call checkpoint 03:17</small></div></li><li><time>10:12</time><div><strong>Mandate confirmed</strong><span>Client confirmed price cap, payment term and Action Window.</span><small>Call checkpoint 01:08</small></div></li></ol></section>
      </article>
    </main>
  );
}
