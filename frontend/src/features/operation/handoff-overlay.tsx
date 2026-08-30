"use client";

import Link from "next/link";
import { useState } from "react";

import { formatDateTime } from "@/lib/dashboard-api";
import type { DashboardHandoff } from "@/lib/dashboard-api";

export function HandoffOverlay({ handoffs }: { handoffs: DashboardHandoff[] }) {
  const [minimizedHandoffId, setMinimizedHandoffId] = useState<string | null>(null);
  const active = handoffs[0];

  if (!active) return null;
  const minimized = minimizedHandoffId === active.id;

  const pending = handoffs.length - 1;
  const queueCopy = pending > 0 ? `${pending} later transfer${pending === 1 ? "" : "s"} queued` : "No other live transfers";
  if (minimized) {
    return (
      <button className="handoff-minimized" type="button" onClick={() => setMinimizedHandoffId(null)} aria-label="Restore live handoff context">
        <span><i aria-hidden="true" />Live transfer</span>
        <strong>{active.operationReference}</strong>
        <em>{pending > 0 ? `+${pending} queued` : "Review context"}</em>
      </button>
    );
  }

  return (
    <section className="handoff-overlay" role="dialog" aria-modal="true" aria-labelledby="handoff-title" aria-describedby="handoff-detail">
      <div className="handoff-overlay-bar">
        <span><i aria-hidden="true" />Call transferred to the supervisor</span>
        <small>{queueCopy}</small>
      </div>
      <div className="handoff-overlay-content">
        <div>
          <p>{active.operationReference} · {active.clientName}</p>
          <h2 id="handoff-title">Human handoff is live.</h2>
          <p id="handoff-detail">{active.reason}</p>
        </div>
        <dl>
          <div><dt>Counterparty</dt><dd>{active.counterpartyName ?? "Not recorded"}</dd></div>
          <div><dt>Transferred</dt><dd>{formatDateTime(active.startedAt)}</dd></div>
        </dl>
      </div>
      <div className="handoff-overlay-actions">
        <button type="button" onClick={() => setMinimizedHandoffId(active.id)}>Minimize</button>
        <Link href={`/dashboard/operations/${active.operationReference}`} onClick={() => setMinimizedHandoffId(active.id)}>Open operation</Link>
      </div>
    </section>
  );
}
