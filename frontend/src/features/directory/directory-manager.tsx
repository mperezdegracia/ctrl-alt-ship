"use client";

import { FormEvent, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { dashboardRequest } from "@/lib/dashboard-api";
import type { DirectoryEntry } from "@/lib/dashboard-api";
import { createClient } from "@/lib/supabase/client";

type DirectoryKind = "contacts" | "providers";
type DirectoryManagerProps = { kind: DirectoryKind; entries: DirectoryEntry[] };
type EditorTarget = { mode: "create" } | { mode: "edit"; entry: DirectoryEntry };

const providerCapabilityKeys = ["company_name", "equipment", "service_areas", "phone_type", "responds_to_quotes"] as const;

async function token(): Promise<string> {
  const { data } = await createClient().auth.getSession();
  if (!data.session?.access_token) throw new Error("Your session has expired. Sign in again before changing the directory.");
  return data.session.access_token;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function commaList(value: FormDataEntryValue | null): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function capabilityText(value: unknown): string {
  return strings(value).join(", ");
}

function operatorText(value: string): string {
  const readable = value.replaceAll("_", " ").replace(/\b(\d+)\s+dry\b/i, "$1′ dry");
  return readable.slice(0, 1).toUpperCase() + readable.slice(1);
}

function providerCapabilities(values: FormData, existing?: Record<string, unknown> | null): Record<string, unknown> {
  const next = Object.fromEntries(Object.entries(existing ?? {}).filter(([key]) => !providerCapabilityKeys.includes(key as typeof providerCapabilityKeys[number])));
  const equipment = commaList(values.get("equipment"));
  const serviceAreas = commaList(values.get("serviceAreas"));
  const companyName = String(values.get("companyName") ?? "").trim();
  const phoneType = String(values.get("phoneType") ?? "").trim();
  const quoteResponse = String(values.get("quoteResponse") ?? "");
  if (companyName) next.company_name = companyName;
  if (equipment.length > 0) next.equipment = equipment;
  if (serviceAreas.length > 0) next.service_areas = serviceAreas;
  if (phoneType) next.phone_type = phoneType;
  if (quoteResponse === "yes") next.responds_to_quotes = true;
  if (quoteResponse === "no") next.responds_to_quotes = false;
  return next;
}

function ProviderCapabilities({ capabilities }: { capabilities: Record<string, unknown> | null }) {
  const equipment = strings(capabilities?.equipment);
  const serviceAreas = strings(capabilities?.service_areas);
  const hasQuoteResponse = typeof capabilities?.responds_to_quotes === "boolean";
  const respondsToQuotes = capabilities?.responds_to_quotes === true;
  const phoneType = typeof capabilities?.phone_type === "string" ? capabilities.phone_type : null;
  const service = [...equipment.map(operatorText), ...serviceAreas.map(operatorText)].join(" · ");
  const availability = !hasQuoteResponse ? "Quote response not recorded" : respondsToQuotes ? "Responds to quote requests" : "Does not respond to quote requests";
  const hasDetails = service.length > 0 || phoneType || hasQuoteResponse;

  if (!hasDetails) return <span className="directory-muted">Not recorded</span>;

  return (
    <dl className="capability-summary">
      {service && <div><dt>Service</dt><dd>{service}</dd></div>}
      <div><dt>Availability</dt><dd>{phoneType ? `${operatorText(phoneType)} · ${availability}` : availability}</dd></div>
    </dl>
  );
}

function providerCompanyName(capabilities: Record<string, unknown> | null): string | null {
  return typeof capabilities?.company_name === "string" && capabilities.company_name.trim() ? capabilities.company_name : null;
}

function DirectoryEditorSheet({ kind, target, onClose, onComplete }: {
  kind: DirectoryKind;
  target: EditorTarget;
  onClose: () => void;
  onComplete: () => void;
}) {
  const firstInputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const entry = target.mode === "edit" ? target.entry : undefined;
  const label = kind === "contacts" ? "contact" : "provider";
  const title = entry ? `Edit ${label}` : `New ${label}`;
  const capabilities = entry?.capabilities ?? null;

  useEffect(() => {
    firstInputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
      if (kind === "providers") body.capabilities = providerCapabilities(values, capabilities);

      const accessToken = await token();
      if (entry) {
        body.expectedUpdatedAt = entry.updatedAt;
        await dashboardRequest(`/api/dashboard/directory/${kind}/${entry.id}`, accessToken, { method: "PATCH", body });
      } else {
        await dashboardRequest(`/api/dashboard/directory/${kind}`, accessToken, { method: "POST", body });
      }
      startTransition(() => { onComplete(); onClose(); });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `The ${label} could not be saved.`);
    }
  }

  async function toggleActive() {
    if (!entry) return;
    setMessage(null);
    try {
      await dashboardRequest(`/api/dashboard/directory/${kind}/${entry.id}`, await token(), {
        method: "PATCH",
        body: { expectedUpdatedAt: entry.updatedAt, active: !entry.active },
      });
      startTransition(() => { onComplete(); onClose(); });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The directory record could not be updated.");
    }
  }

  return (
    <>
      <div className="directory-sheet-backdrop" aria-hidden="true" onMouseDown={onClose} />
      <aside className="directory-sheet-modal" role="dialog" aria-modal="true" aria-labelledby="directory-sheet-title">
      <div className="directory-sheet-frame">
        <header className="directory-sheet-header">
          <div>
            <p>{entry ? entry.active ? "Active record" : "Inactive record" : "Catalog entry"}</p>
            <h2 id="directory-sheet-title">{title}</h2>
          </div>
          <button type="button" className="directory-sheet-close" onClick={onClose} aria-label="Close directory editor">Close</button>
        </header>

        <p className="directory-sheet-intro">
          {kind === "contacts"
            ? "Use this record for a real person who can be identified during an operation. Changes remain auditable."
            : "Maintain the provider catalog in operational terms. Coverage and equipment are used to understand the supplier before a request is made."}
        </p>

        <form className="ledger-form directory-sheet-form" onSubmit={(event) => void submit(event)}>
          <label>{kind === "contacts" ? "Name" : "Primary contact"}<input ref={firstInputRef} name="name" required defaultValue={entry?.name ?? ""} maxLength={240} /></label>
          <label>Phone<input name="phone" required defaultValue={entry?.phone ?? ""} pattern="\+[1-9][0-9]{7,14}" placeholder="+5491100000000" /></label>
          <label>Email<input name="email" type="email" defaultValue={entry?.email ?? ""} maxLength={320} placeholder="Not recorded" /></label>
          {kind === "contacts" ? (
            <label className="ledger-check directory-sheet-check"><input name="authorized" type="checkbox" defaultChecked={entry?.authorized ?? true} />May authorize work</label>
          ) : (
            <fieldset className="provider-fieldset">
              <legend>Provider capability record</legend>
              <p>Use comma-separated terms where there can be more than one value.</p>
              <div className="directory-sheet-grid">
                <label className="directory-sheet-wide">Company name<input name="companyName" defaultValue={providerCompanyName(capabilities) ?? ""} placeholder="Not recorded" /></label>
                <label>Equipment<input name="equipment" defaultValue={capabilityText(capabilities?.equipment)} placeholder="40 dry, 20 reefer" /></label>
                <label>Service areas<input name="serviceAreas" defaultValue={capabilityText(capabilities?.service_areas)} placeholder="AMBA, Buenos Aires" /></label>
                <label>Contact method<input name="phoneType" defaultValue={typeof capabilities?.phone_type === "string" ? capabilities.phone_type : ""} placeholder="Mobile" /></label>
                <label>Quote response<select name="quoteResponse" defaultValue={capabilities?.responds_to_quotes === true ? "yes" : capabilities?.responds_to_quotes === false ? "no" : ""}><option value="">Not recorded</option><option value="yes">Responds to requests</option><option value="no">Does not respond</option></select></label>
              </div>
            </fieldset>
          )}
          <div className="directory-sheet-actions">
            <button type="submit" disabled={isPending}>{isPending ? "Saving record" : entry ? "Save record" : `Add ${label}`}</button>
            {entry && <button type="button" className="ledger-secondary-button" onClick={() => void toggleActive()} disabled={isPending}>{entry.active ? "Deactivate record" : "Reactivate record"}</button>}
          </div>
          {message && <p className="inline-form-error" role="alert">{message}</p>}
        </form>
      </div>
      </aside>
    </>
  );
}

export function DirectoryManager({ kind, entries }: DirectoryManagerProps) {
  const router = useRouter();
  const [target, setTarget] = useState<EditorTarget | null>(null);
  const singular = kind === "contacts" ? "contact" : "provider";
  const title = useMemo(() => kind === "contacts" ? "New contact" : "New provider", [kind]);

  return (
    <section className="directory-manager" aria-label={`${kind} directory`}>
      <div className="directory-register-actions">
        <p>{kind === "contacts" ? "People who can be reached or authorize work." : "Service providers available to the operating team."}</p>
        <button type="button" className="directory-new-record" onClick={() => setTarget({ mode: "create" })}>{title}</button>
      </div>
      {entries.length > 0 ? (
        <div className="operations-table-wrap">
          <table className="operations-table directory-table">
            <thead><tr><th>{singular}</th><th>Phone</th><th>Email</th><th>{kind === "contacts" ? "Authority" : "Capability record"}</th><th>State</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{entries.map((entry) => (
              <tr key={entry.id} className={entry.active ? undefined : "directory-row-inactive"}>
                <td><strong>{kind === "providers" ? providerCompanyName(entry.capabilities) ?? entry.name : entry.name}</strong>{kind === "providers" && providerCompanyName(entry.capabilities) && <span className="directory-contact-name">{entry.name}</span>}</td>
                <td>{entry.phone}</td>
                <td>{entry.email ?? <span className="directory-muted">Not recorded</span>}</td>
                <td>{kind === "contacts" ? <span className={entry.authorized ? "directory-authorized" : "directory-muted"}>{entry.authorized ? "May authorize work" : "Contact only"}</span> : <ProviderCapabilities capabilities={entry.capabilities} />}</td>
                <td><span className={`status-mark ${entry.active ? "status-booking-confirmed" : "status-failed"}`}>{entry.active ? "Active" : "Inactive"}</span></td>
                <td><button type="button" className="directory-open-record" onClick={() => setTarget({ mode: "edit", entry })}>Open</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="section-empty-copy">No {kind} match this view.</p>}
      {target && <DirectoryEditorSheet kind={kind} target={target} onClose={() => setTarget(null)} onComplete={() => router.refresh()} />}
    </section>
  );
}
