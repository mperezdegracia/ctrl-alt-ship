export default function DashboardLoading() {
  return (
    <main className="dashboard-shell dashboard-state-shell" aria-busy="true" aria-live="polite">
      <section className="dashboard-loading" aria-label="Loading operations">
        <span />
        <span />
        <span />
      </section>
    </main>
  );
}
