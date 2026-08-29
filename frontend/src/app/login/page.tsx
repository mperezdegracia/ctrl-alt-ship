import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="access-shell">
      <section className="access-intro" aria-labelledby="nauta-title">
        <div className="wordmark" aria-label="Nauta">
          <span className="wordmark-mark" aria-hidden="true">N</span>
          <span>Nauta</span>
        </div>
        <div className="intro-copy">
          <p className="section-label">Operations center</p>
          <h1 id="nauta-title">Every movement, under control.</h1>
          <p>
            Access Tango&apos;s operational record to supervise Operations,
            Commitments, and Escalations with verified context.
          </p>
        </div>
        <div className="route-sheet" aria-label="Operating principles">
          <div className="route-line route-line-one" />
          <div className="route-line route-line-two" />
          <span className="route-node route-node-one" />
          <span className="route-node route-node-two" />
          <span className="route-node route-node-three" />
          <p>Validated mandate</p>
          <p>Auditable commitments</p>
          <p>Visible escalations</p>
        </div>
        <p className="intro-footnote">Nauta · Ground coordination</p>
      </section>

      <section className="access-panel" aria-labelledby="login-title">
        <div className="access-panel-inner">
          <p className="section-label">Supervisor access</p>
          <h2 id="login-title">Start your shift.</h2>
          <p className="access-description">Use the credentials assigned by Nauta.</p>
          <LoginForm />
          <p className="access-notice">
            Access is restricted to authorized Supervisors. Accounts are managed by Nauta.
          </p>
        </div>
      </section>
    </main>
  );
}
