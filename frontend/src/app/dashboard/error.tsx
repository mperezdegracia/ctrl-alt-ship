"use client";

export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="dashboard-shell dashboard-state-shell">
      <section className="dashboard-state" aria-labelledby="dashboard-error-title">
        <p className="operation-reference">Operations center</p>
        <h1 id="dashboard-error-title">The operation record is temporarily unavailable.</h1>
        <p>Tango could not read the latest verified data. Retry the request; no operational action has been changed.</p>
        <button type="button" onClick={reset}>Try again</button>
      </section>
    </main>
  );
}
