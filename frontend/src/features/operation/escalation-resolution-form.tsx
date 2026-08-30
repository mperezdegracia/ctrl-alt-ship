"use client";

import { FormEvent, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { dashboardRequest } from "@/lib/dashboard-api";
import { createClient } from "@/lib/supabase/client";

const MODAL_EXIT_MS = 180;

export function EscalationResolutionForm({ escalationId }: { escalationId: string }) {
  const router = useRouter();
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const close = useCallback(() => {
    if (closing || isPending) return;
    setClosing(true);
    window.setTimeout(() => { setOpen(false); setClosing(false); setMessage(null); }, MODAL_EXIT_MS);
  }, [closing, isPending]);

  useEffect(() => {
    if (!open || closing) return;
    firstFieldRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, closing, close]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const values = new FormData(event.currentTarget);
    try {
      const { data } = await createClient().auth.getSession();
      if (!data.session?.access_token) throw new Error("Your session has expired. Sign in again before closing the escalation.");
      await dashboardRequest(`/api/dashboard/escalations/${escalationId}/resolve`, data.session.access_token, {
        method: "PATCH",
        body: { resolution: values.get("resolution"), note: String(values.get("note") ?? "").trim() },
      });
      startTransition(() => router.refresh());
      setMessage("Handoff outcome recorded.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The handoff outcome could not be recorded.");
    }
  }

  return <>
    <button type="button" className="escalation-resolve-button" onClick={() => setOpen(true)}>Resolve</button>
    {open && <>
      <div className={`resolution-modal-backdrop${closing ? " is-closing" : ""}`} aria-hidden="true" onMouseDown={closing ? undefined : close} />
      <section className={`resolution-modal${closing ? " is-closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby={`resolve-${escalationId}`}>
        <header>
          <div><p>Human decision</p><h2 id={`resolve-${escalationId}`}>Resolve escalation</h2></div>
          <button type="button" className="resolution-modal-close" onClick={close} disabled={isPending}>Close</button>
        </header>
        <p className="resolution-modal-intro">Record the confirmed outcome and the next operational step. This decision remains attached to the escalation.</p>
        <form className="ledger-form resolution-modal-form" onSubmit={(event) => void submit(event)}>
          <label>Handoff outcome
            <select ref={firstFieldRef} name="resolution" defaultValue="approved">
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="follow_up">Follow-up required</option>
            </select>
          </label>
          <label>Operator note<textarea name="note" required minLength={1} maxLength={2000} rows={4} placeholder="State what was decided and what happens next." /></label>
          <div className="resolution-modal-actions">
            <button type="submit" disabled={isPending}>{isPending ? "Recording outcome" : "Record outcome"}</button>
            {message && <p className={message.startsWith("Handoff") ? "inline-form-success" : "inline-form-error"} role="status">{message}</p>}
          </div>
        </form>
      </section>
    </>}
  </>;
}
