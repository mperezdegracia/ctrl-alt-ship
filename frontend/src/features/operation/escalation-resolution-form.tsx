"use client";

import { FormEvent, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { dashboardRequest } from "@/lib/dashboard-api";
import { createClient } from "@/lib/supabase/client";

export function EscalationResolutionForm({ escalationId }: { escalationId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

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

  return (
    <form className="ledger-form resolution-form" onSubmit={(event) => void submit(event)}>
      <label>Handoff outcome
        <select name="resolution" defaultValue="approved">
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="follow_up">Follow-up required</option>
        </select>
      </label>
      <label>Operator note<textarea name="note" required minLength={1} maxLength={2000} rows={3} placeholder="State what was decided and what happens next." /></label>
      <div className="ledger-form-actions">
        <button type="submit" disabled={isPending}>{isPending ? "Recording outcome" : "Record outcome"}</button>
        {message && <p className={message.startsWith("Handoff") ? "inline-form-success" : "inline-form-error"} role="status">{message}</p>}
      </div>
    </form>
  );
}
