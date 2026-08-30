"use client";

import { FormEvent, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { dashboardRequest } from "@/lib/dashboard-api";
import type { SavedView } from "@/lib/dashboard-api";
import { createClient } from "@/lib/supabase/client";

type SavedViewControlsProps = {
  scope: "operations" | "escalations";
  views: SavedView[];
  configuration: Record<string, string | undefined>;
  pathname: string;
};

async function accessToken(): Promise<string> {
  const { data } = await createClient().auth.getSession();
  if (!data.session?.access_token) throw new Error("Your session has expired. Sign in again to save a view.");
  return data.session.access_token;
}

function queryFor(pathname: string, configuration: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(configuration)) {
    if (typeof value === "string" && value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function SavedViewControls({ scope, views, configuration, pathname }: SavedViewControlsProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function apply(configurationToApply: Record<string, unknown>) {
    router.push(queryFor(pathname, configurationToApply));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    setMessage(null);
    try {
      const token = await accessToken();
      await dashboardRequest("/api/dashboard/saved-views", token, {
        method: "POST",
        body: { scope, name: name.trim(), configuration },
      });
      setName("");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The view could not be saved.");
    }
  }

  async function remove(id: string) {
    setMessage(null);
    try {
      const token = await accessToken();
      await dashboardRequest(`/api/dashboard/saved-views/${id}`, token, { method: "DELETE" });
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The view could not be removed.");
    }
  }

  return (
    <section className="saved-views" aria-label="Saved views">
      <div className="saved-view-list">
        <button type="button" className="saved-view-system" onClick={() => apply({})}>All records</button>
        {views.map((view) => (
          <span key={view.id} className="saved-view-item">
            <button type="button" onClick={() => apply(view.configuration)}>{view.name}</button>
            <button type="button" className="saved-view-remove" onClick={() => void remove(view.id)} aria-label={`Remove ${view.name}`}>×</button>
          </span>
        ))}
      </div>
      <form className="saved-view-save" onSubmit={(event) => void save(event)}>
        <label htmlFor={`${scope}-view-name`}>Save this view</label>
        <input id={`${scope}-view-name`} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="View name" />
        <button type="submit" disabled={isPending || !name.trim()}>{isPending ? "Saving" : "Save"}</button>
      </form>
      {message && <p className="inline-form-error" role="alert">{message}</p>}
    </section>
  );
}
