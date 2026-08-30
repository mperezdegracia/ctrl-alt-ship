"use client";

import Link from "next/link";
import { useState } from "react";

import { formatDateTime } from "@/lib/dashboard-api";
import type { DashboardHandoff } from "@/lib/dashboard-api";

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
  const [minimizedHandoffId, setMinimizedHandoffId] = useState<string | null>(null);
  const active = handoffs[0];

  if (!active) return null;
  const minimized = minimizedHandoffId === active.id;

  const pending = handoffs.length - 1;
  const state = handoffState(active);
  const queueCopy = pending > 0 ? `${pending} later transfer${pending === 1 ? "" : "s"} queued` : "No other live transfers";
  if (minimized) {
    return (
      <button className="handoff-minimized" type="button" onClick={() => setMinimizedHandoffId(null)} aria-label="Restore live handoff context">
        <span><i aria-hidden="true" />Human review</span>
        <strong>{active.operationReference}</strong>
        <em>{pending > 0 ? `+${pending} queued` : state.label}</em>
      </button>
    );
  }

  return (
    <section className={`handoff-overlay is-${active.handoffStatus}`} role="region" aria-live="assertive" aria-labelledby="handoff-title" aria-describedby="handoff-detail">
      <div className="handoff-overlay-bar">
        <span><i aria-hidden="true" />{state.label}</span>
        <small>{queueCopy}</small>
      </div>
      <div className="handoff-overlay-content">
        <div>
          <p>{active.operationReference} · {active.clientName}</p>
          <h2 id="handoff-title">{active.requestedAction}</h2>
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
        <button type="button" onClick={() => setMinimizedHandoffId(active.id)}>Minimize</button>
        <Link href={`/dashboard/operations/${active.operationReference}`} onClick={() => setMinimizedHandoffId(active.id)}>Open operation</Link>
      </div>
    </section>
  );
}
