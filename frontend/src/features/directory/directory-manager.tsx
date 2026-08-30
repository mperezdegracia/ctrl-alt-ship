"use client";

import { FormEvent, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { dashboardRequest } from "@/lib/dashboard-api";
import type { DirectoryEntry } from "@/lib/dashboard-api";
import { createClient } from "@/lib/supabase/client";

type DirectoryManagerProps = { kind: "contacts" | "providers"; entries: DirectoryEntry[] };

async function token(): Promise<string> {
  const { data } = await createClient().auth.getSession();
  if (!data.session?.access_token) throw new Error("Your session has expired. Sign in again before changing the directory.");
  return data.session.access_token;
}

function readCapabilities(value: FormDataEntryValue | null): Record<string, unknown> | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const parsed: unknown = JSON.parse(text);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Capabilities must be a JSON object.");
  return parsed as Record<string, unknown>;
}

function DirectoryCreateForm({ kind, onComplete }: { kind: DirectoryManagerProps["kind"]; onComplete: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const label = kind === "contacts" ? "contact" : "provider";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const values = new FormData(event.currentTarget);
    try {
      const body: Record<string, unknown> = {
        name: String(values.get("name") ?? "").trim(),
        phone: String(values.get("phone") ?? "").trim(),
        email: String(values.get("email") ?? "").trim() || null,
      };
      if (kind === "contacts") body.authorized = values.get("authorized") === "on";
      if (kind === "providers") body.capabilities = readCapabilities(values.get("capabilities")) ?? {};
      await dashboardRequest(`/api/dashboard/directory/${kind}`, await token(), { method: "POST", body });
      event.currentTarget.reset();
      startTransition(onComplete);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `The ${label} could not be created.`);
    }
  }

  return (
    <details className="directory-create">
      <summary>Add {label}</summary>
      <form className="ledger-form ledger-form-grid" onSubmit={(event) => void submit(event)}>
        <label>Name<input name="name" required maxLength={240} /></label>
        <label>Phone<input name="phone" required pattern="\+[1-9][0-9]{7,14}" placeholder="+5491100000000" /></label>
        <label>Email<input name="email" type="email" maxLength={320} /></label>
        {kind === "contacts" ? <label className="ledger-check"><input name="authorized" type="checkbox" defaultChecked />Authorized caller</label> :
          <label>Capabilities (JSON)<textarea name="capabilities" rows={3} placeholder='{"equipment": ["20ft"]}' /></label>}
        <div className="ledger-form-actions ledger-form-wide"><button type="submit" disabled={isPending}>{isPending ? "Creating" : `Add ${label}`}</button></div>
        {message && <p className="inline-form-error ledger-form-wide" role="alert">{message}</p>}
      </form>
    </details>
  );
}

function DirectoryEditForm({ entry, kind, onComplete }: { entry: DirectoryEntry; kind: DirectoryManagerProps["kind"]; onComplete: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const values = new FormData(event.currentTarget);
    try {
      const body: Record<string, unknown> = {
        expectedUpdatedAt: entry.updatedAt,
        name: String(values.get("name") ?? "").trim(),
        phone: String(values.get("phone") ?? "").trim(),
        email: String(values.get("email") ?? "").trim() || null,
      };
      if (kind === "contacts") body.authorized = values.get("authorized") === "on";
      if (kind === "providers") body.capabilities = readCapabilities(values.get("capabilities")) ?? {};
      await dashboardRequest(`/api/dashboard/directory/${kind}/${entry.id}`, await token(), { method: "PATCH", body });
      startTransition(onComplete);
      setMessage("Directory record updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The directory record could not be updated.");
    }
  }

  async function toggleActive() {
    setMessage(null);
    try {
      await dashboardRequest(`/api/dashboard/directory/${kind}/${entry.id}`, await token(), {
        method: "PATCH", body: { expectedUpdatedAt: entry.updatedAt, active: !entry.active },
      });
      startTransition(onComplete);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The directory record could not be updated.");
    }
  }

  return (
    <details className="directory-edit">
      <summary>Edit</summary>
      <form className="ledger-form ledger-form-grid" onSubmit={(event) => void submit(event)}>
        <label>Name<input name="name" required defaultValue={entry.name} maxLength={240} /></label>
        <label>Phone<input name="phone" required defaultValue={entry.phone} pattern="\+[1-9][0-9]{7,14}" /></label>
        <label>Email<input name="email" type="email" defaultValue={entry.email ?? ""} maxLength={320} /></label>
        {kind === "contacts" ? <label className="ledger-check"><input name="authorized" type="checkbox" defaultChecked={entry.authorized ?? false} />Authorized caller</label> :
          <label>Capabilities (JSON)<textarea name="capabilities" defaultValue={JSON.stringify(entry.capabilities ?? {}, null, 2)} rows={3} /></label>}
        <div className="ledger-form-actions ledger-form-wide">
          <button type="submit" disabled={isPending}>{isPending ? "Saving" : "Save changes"}</button>
          <button type="button" className="ledger-secondary-button" onClick={() => void toggleActive()} disabled={isPending}>{entry.active ? "Deactivate" : "Reactivate"}</button>
        </div>
        {message && <p className={message.startsWith("Directory") ? "inline-form-success ledger-form-wide" : "inline-form-error ledger-form-wide"} role="status">{message}</p>}
      </form>
    </details>
  );
}

export function DirectoryManager({ kind, entries }: DirectoryManagerProps) {
  const router = useRouter();
  const singular = kind === "contacts" ? "contact" : "provider";
  return (
    <section className="directory-manager" aria-label={`${kind} directory`}>
      <DirectoryCreateForm kind={kind} onComplete={() => router.refresh()} />
      {entries.length > 0 ? (
        <div className="operations-table-wrap">
          <table className="operations-table directory-table">
            <thead><tr><th>{singular}</th><th>Phone</th><th>Email</th><th>{kind === "contacts" ? "Authorization" : "Capabilities"}</th><th>State</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{entries.map((entry) => (
              <tr key={entry.id} className={entry.active ? undefined : "directory-row-inactive"}>
                <td><strong>{entry.name}</strong></td>
                <td>{entry.phone}</td>
                <td>{entry.email ?? "Not recorded"}</td>
                <td>{kind === "contacts" ? entry.authorized ? "Authorized" : "Not authorized" : Object.keys(entry.capabilities ?? {}).length > 0 ? JSON.stringify(entry.capabilities) : "Not recorded"}</td>
                <td><span className={`status-mark ${entry.active ? "status-booking-confirmed" : "status-failed"}`}>{entry.active ? "Active" : "Inactive"}</span></td>
                <td><DirectoryEditForm entry={entry} kind={kind} onComplete={() => router.refresh()} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="section-empty-copy">No {kind} match this view.</p>}
    </section>
  );
}
