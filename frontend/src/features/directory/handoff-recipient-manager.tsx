"use client";

import { FormEvent, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { dashboardRequest, type HandoffRecipient } from "@/lib/dashboard-api";
import { createClient } from "@/lib/supabase/client";

const EXIT_MS = 220;

async function token(): Promise<string> {
  const { data } = await createClient().auth.getSession();
  if (!data.session?.access_token) throw new Error("Your session has expired. Sign in again before changing handoff routing.");
  return data.session.access_token;
}

type Target = { mode: "create" } | { mode: "edit"; recipient: HandoffRecipient };

function RecipientSheet({ closing, target, onClose, onComplete }: {
  closing: boolean;
  target: Target;
  onClose: () => void;
  onComplete: () => void;
}) {
  const firstInputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const recipient = target.mode === "edit" ? target.recipient : undefined;

  useEffect(() => {
    if (closing) return;
    firstInputRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closing, onClose]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const values = new FormData(event.currentTarget);
    const priority = Number(values.get("priority"));
    if (!Number.isInteger(priority) || priority < 1 || priority > 32_767) {
      setMessage("Priority must be a whole number between 1 and 32767.");
      return;
    }
    const body = {
      name: String(values.get("name") ?? "").trim(),
      phone: String(values.get("phone") ?? "").trim(),
      role: String(values.get("role") ?? ""),
      priority,
    };
    try {
      const accessToken = await token();
      if (recipient) {
        await dashboardRequest(`/api/dashboard/handoff-recipients/${recipient.id}`, accessToken, {
          method: "PATCH", body: { ...body, expectedUpdatedAt: recipient.updatedAt },
        });
      } else {
        await dashboardRequest("/api/dashboard/handoff-recipients", accessToken, { method: "POST", body });
      }
      startTransition(() => { onComplete(); onClose(); });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The handoff recipient could not be saved.");
    }
  }

  async function toggleActive() {
    if (!recipient) return;
    setMessage(null);
    try {
      await dashboardRequest(`/api/dashboard/handoff-recipients/${recipient.id}`, await token(), {
        method: "PATCH", body: { expectedUpdatedAt: recipient.updatedAt, active: !recipient.active },
      });
      startTransition(() => { onComplete(); onClose(); });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The recipient state could not be updated.");
    }
  }

  return <>
    <div className={`directory-sheet-backdrop${closing ? " is-closing" : ""}`} aria-hidden="true" onMouseDown={closing ? undefined : onClose} />
    <aside className={`directory-sheet-modal${closing ? " is-closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="recipient-sheet-title">
      <div className="directory-sheet-frame">
        <header className="directory-sheet-header">
          <div>
            <p>{recipient ? recipient.active ? "Active routing record" : "Inactive routing record" : "Handoff routing"}</p>
            <h2 id="recipient-sheet-title">{recipient ? "Edit recipient" : "New recipient"}</h2>
          </div>
          <button type="button" className="directory-sheet-close" onClick={onClose} aria-label="Close handoff recipient editor">Close</button>
        </header>
        <p className="directory-sheet-intro">This is an outbound human-routing record. It is separate from client and provider caller identities, so changing it never changes inbound call matching.</p>
        <form className="ledger-form directory-sheet-form" onSubmit={(event) => void submit(event)}>
          <label className="directory-sheet-wide">Name<input ref={firstInputRef} name="name" required maxLength={240} defaultValue={recipient?.name ?? ""} /></label>
          <label>Outbound phone<input name="phone" required pattern="\+[1-9][0-9]{7,14}" placeholder="+5491100000000" defaultValue={recipient?.phone ?? ""} /></label>
          <label>Role<select name="role" defaultValue={recipient?.role ?? "operator"}><option value="operator">Operator</option><option value="supervisor">Supervisor</option></select></label>
          <label>Priority<input name="priority" type="number" required min={1} max={32767} step={1} defaultValue={recipient?.priority ?? 100} /></label>
          <p className="recipient-priority-help">Lower numbers are selected first when more than one active recipient is available.</p>
          <div className="directory-sheet-actions">
            <button type="submit" disabled={isPending}>{isPending ? "Saving recipient" : recipient ? "Save recipient" : "Add recipient"}</button>
            {recipient && <button type="button" className="ledger-secondary-button" onClick={() => void toggleActive()} disabled={isPending}>{recipient.active ? "Deactivate recipient" : "Reactivate recipient"}</button>}
          </div>
          {message && <p className="inline-form-error" role="alert">{message}</p>}
        </form>
      </div>
    </aside>
  </>;
}

export function HandoffRecipientManager({ recipients }: { recipients: HandoffRecipient[] }) {
  const router = useRouter();
  const [target, setTarget] = useState<Target | null>(null);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  const close = useCallback(() => {
    if (!target || closing) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      setTarget(null);
      setClosing(false);
      triggerRef.current?.focus();
    }, EXIT_MS);
  }, [closing, target]);
  function open(next: Target, trigger: HTMLButtonElement) {
    window.clearTimeout(closeTimer.current);
    triggerRef.current = trigger;
    setClosing(false);
    setTarget(next);
  }

  return <section className="directory-manager" aria-label="Human handoff recipients">
    <div className="directory-register-actions">
      <p>Active records are selected by priority for each human escalation. Inactive records remain in the audit trail.</p>
      <button type="button" className="directory-new-record" onClick={(event) => open({ mode: "create" }, event.currentTarget)}>New recipient</button>
    </div>
    {recipients.length > 0 ? <div className="operations-table-wrap">
      <table className="operations-table directory-table recipient-table">
        <thead><tr><th>Recipient</th><th>Outbound phone</th><th>Role</th><th>Priority</th><th>State</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{recipients.map((recipient) => <tr key={recipient.id} className={recipient.active ? undefined : "directory-row-inactive"}>
          <td><strong>{recipient.name}</strong></td><td>{recipient.phone}</td><td>{recipient.role === "supervisor" ? "Supervisor" : "Operator"}</td><td>{recipient.priority}</td>
          <td><span className={`status-mark ${recipient.active ? "status-booking-confirmed" : "status-failed"}`}>{recipient.active ? "Active" : "Inactive"}</span></td>
          <td><button type="button" className="directory-open-record" onClick={(event) => open({ mode: "edit", recipient }, event.currentTarget)}>Open</button></td>
        </tr>)}</tbody>
      </table>
    </div> : <p className="section-empty-copy">No handoff recipients match this view. Escalations will stay open for manual review until an active recipient is added.</p>}
    {target && <RecipientSheet closing={closing} target={target} onClose={close} onComplete={() => router.refresh()} />}
  </section>;
}
