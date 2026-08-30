import Image from "next/image";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="access-shell">
      <section className="access-intro" aria-labelledby="tango-title">
        <div className="wordmark" aria-label="Tango">
          <Image className="wordmark-mark" src="/tango.png" alt="" width={30} height={30} priority />
          <span>Tango</span>
        </div>
        <div className="intro-copy">
          <h1 id="tango-title">Every movement, under control.</h1>
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
        <p className="intro-footnote">Tango · Ground coordination</p>
      </section>

      <section className="access-panel" aria-labelledby="login-title">
        <div className="access-panel-inner">
          <h2 id="login-title">Start your shift.</h2>
          <p className="access-description">Use the credentials assigned by Tango.</p>
          <LoginForm />
          <p className="access-notice">
            Access is restricted to authorized Supervisors. Accounts are managed by Tango.
          </p>
        </div>
      </section>
    </main>
  );
}
