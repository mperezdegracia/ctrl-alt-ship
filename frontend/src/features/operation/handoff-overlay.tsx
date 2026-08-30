"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";

import { formatDateTime } from "@/lib/dashboard-api";
import type { DashboardHandoff } from "@/lib/dashboard-api";

const minimizedHandoffStorageKey = "tango:minimized-handoff";
const minimizedHandoffChangedEvent = "tango:minimized-handoff-changed";
const MINIMIZED_HANDOFF_EXIT_MS = 180;

function subscribeToMinimizedHandoff(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(minimizedHandoffChangedEvent, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(minimizedHandoffChangedEvent, onStoreChange);
  };
}

function minimizedHandoffSnapshot(): string | null {
  return window.localStorage.getItem(minimizedHandoffStorageKey);
}

function serverMinimizedHandoffSnapshot(): null {
  return null;
}

function markMinimizedHandoffChanged() {
  window.dispatchEvent(new Event(minimizedHandoffChangedEvent));
}

function handoffState(handoff: DashboardHandoff): { label: string; detail: string } {
  switch (handoff.handoffStatus) {
    case "transfer_requested":
      return { label: "Transfer request sent", detail: handoff.recipient ? `Routing to ${handoff.recipient.name}, ${handoff.recipient.role}.` : "The voice transfer request was accepted." };
    case "transfer_failed":
      return { label: "Transfer failed — review remains open", detail: handoff.handoffStatusDetail ?? "The voice transfer could not be completed. Resolve this case manually." };
    case "not_configured":
      return { label: "No recipient configured", detail: "Human review is open, but no active handoff recipient is configured." };
    default:
      return { label: "Human review opened", detail: handoff.recipient ? `Preparing context for ${handoff.recipient.name}, ${handoff.recipient.role}.` : "Preparing the durable handoff brief." };
  }
}

export function HandoffOverlay({ handoffs }: { handoffs: DashboardHandoff[] }) {
  const active = handoffs[0];
  const hasHydrated = useSyncExternalStore(() => () => {}, () => true, () => false);
  const minimizedHandoffId = useSyncExternalStore(subscribeToMinimizedHandoff, minimizedHandoffSnapshot, serverMinimizedHandoffSnapshot);
  const [restoring, setRestoring] = useState(false);

  function minimize() {
    if (!active) return;
    window.localStorage.setItem(minimizedHandoffStorageKey, active.id);
    markMinimizedHandoffChanged();
  }

  function restore() {
    if (restoring) return;
    setRestoring(true);
    window.setTimeout(() => {
      window.localStorage.removeItem(minimizedHandoffStorageKey);
      markMinimizedHandoffChanged();
      setRestoring(false);
    }, MINIMIZED_HANDOFF_EXIT_MS);
  }

  if (!active || !hasHydrated) return null;
  const minimized = minimizedHandoffId === active.id;

  const pending = handoffs.length - 1;
  const state = handoffState(active);
  const queueCopy = pending > 0 ? `${pending} later transfer${pending === 1 ? "" : "s"} queued` : "No other live transfers";
  if (minimized) {
    return (
      <button className={`handoff-minimized${restoring ? " is-closing" : ""}`} type="button" onClick={restore} aria-label="Restore live handoff context">
        <span><i aria-hidden="true" />Human review</span>
        <strong>{active.operationReference}</strong>
        <em>{pending > 0 ? `+${pending} queued` : state.label}</em>
      </button>
    );
  }

  return (
    <section className={`handoff-overlay is-${active.handoffStatus}`} role="region" aria-live="assertive" aria-label={state.label} aria-describedby="handoff-detail">
      <div className="handoff-overlay-bar">
        <span><i aria-hidden="true" />{state.label}</span>
        <small>{queueCopy}</small>
      </div>
      <div className="handoff-overlay-content">
        <div>
          <p>{active.operationReference} · {active.clientName}</p>
          <p className="handoff-requested-action">{active.requestedAction}</p>
          <p id="handoff-detail">{active.summary}</p>
          <p className="handoff-state-detail">{state.detail}</p>
        </div>
        <dl>
          <div><dt>Counterparty</dt><dd>{active.counterpartyName ?? "Not recorded"}</dd></div>
          <div><dt>Opened</dt><dd>{formatDateTime(active.startedAt)}</dd></div>
          <div><dt>Decision</dt><dd>{active.reason}</dd></div>
        </dl>
      </div>
      <div className="handoff-overlay-actions">
        <button type="button" onClick={minimize}>Minimize</button>
        <Link href={`/dashboard/operations/${active.operationReference}`} onClick={minimize}>Open operation</Link>
      </div>
    </section>
  );
}
