"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { formatDateTime } from "@/lib/dashboard-api";
import type { DashboardOperationDossier } from "@/lib/dashboard-api";

type OperationTraceProps = { trace: DashboardOperationDossier["trace"] };
type TraceNode = NonNullable<DashboardOperationDossier["trace"]>["nodes"][number];

function eventKind(node: TraceNode): string {
  if (node.kind === "call_started") return "Call opened";
  if (node.kind === "call_ended") return "Call closed";
  return node.sourceCall ? "Verified during call" : "Operation event";
}

function NodeChanges({ node }: { node: TraceNode }) {
  if (node.changes.length === 0) return null;
  return (
    <dl className="evidence-changes">
      {node.changes.map((change) => (
        <div key={change.label}>
          <dt>{change.label}</dt>
          <dd>{change.before && <span>{change.before}</span>}<strong>{change.after}</strong></dd>
        </div>
      ))}
    </dl>
  );
}

function EvidenceSource({ node }: { node: TraceNode }) {
  if (!node.sourceCall && node.recordingCheckpoint === null) return null;
  return (
    <p className="evidence-source">
      {node.sourceCall && <>During {node.sourceCall.description.toLocaleLowerCase()} with <strong>{node.sourceCall.label}</strong></>}
      {node.sourceCall && node.recordingCheckpoint !== null && <span aria-hidden="true"> · </span>}
      {node.recordingCheckpoint !== null && <>Evidence at {node.recordingCheckpoint.toFixed(2)}s</>}
    </p>
  );
}

function DecisionLedger({ nodes, arrivedId }: { nodes: TraceNode[]; arrivedId: string | null }) {
  const ledgerRef = useRef<HTMLOListElement>(null);
  const knownIds = useRef<Set<string> | null>(null);
  const previousHeight = useRef(0);
  const pinnedToLatest = useRef(true);
  const [unseenEntries, setUnseenEntries] = useState(0);
  const recentNodes = useMemo(() => [...nodes].reverse(), [nodes]);

  useLayoutEffect(() => {
    const ledger = ledgerRef.current;
    if (!ledger) return;

    const previousIds = knownIds.current;
    if (previousIds === null) {
      knownIds.current = new Set(nodes.map((node) => node.id));
      previousHeight.current = ledger.scrollHeight;
      return;
    }

    const additions = nodes.filter((node) => !previousIds.has(node.id));
    if (additions.length > 0) {
      if (pinnedToLatest.current) {
        ledger.scrollTop = 0;
        setUnseenEntries(0);
      } else {
        ledger.scrollTop += ledger.scrollHeight - previousHeight.current;
        setUnseenEntries((current) => current + additions.length);
      }
    }

    knownIds.current = new Set(nodes.map((node) => node.id));
    previousHeight.current = ledger.scrollHeight;
  }, [nodes]);

  function handleScroll() {
    const ledger = ledgerRef.current;
    if (!ledger) return;
    const atLatest = ledger.scrollTop < 8;
    pinnedToLatest.current = atLatest;
    if (atLatest) setUnseenEntries(0);
  }

  function showLatest() {
    const ledger = ledgerRef.current;
    if (!ledger) return;
    ledger.scrollTop = 0;
    pinnedToLatest.current = true;
    setUnseenEntries(0);
  }

  return (
    <section className="trace-study trace-study-ledger">
      <div className="decision-ledger-utility">
        <span>Latest first · {nodes.length} recorded {nodes.length === 1 ? "event" : "events"}</span>
        {unseenEntries > 0 && <button type="button" onClick={showLatest}>Show {unseenEntries} new {unseenEntries === 1 ? "entry" : "entries"}</button>}
      </div>
      <ol ref={ledgerRef} className="decision-ledger" aria-label="Decision ledger, latest events first" onScroll={handleScroll} tabIndex={0}>
        {recentNodes.map((node) => (
          <li key={node.id} className={node.id === arrivedId ? "is-new-evidence" : undefined}>
            <time dateTime={node.occurredAt}>{formatDateTime(node.occurredAt)}</time>
            <span className={`decision-mark is-${node.kind}`} aria-hidden="true" />
            <div className="decision-entry">
              <span>{eventKind(node)}</span>
              <strong>{node.title}</strong>
              {node.detail && <p>{node.detail}</p>}
              <NodeChanges node={node} />
              <EvidenceSource node={node} />
            </div>
          </li>
        ))}
      </ol>
      <span className="sr-only" aria-live="polite">{unseenEntries > 0 ? `${unseenEntries} new ${unseenEntries === 1 ? "entry is" : "entries are"} available at the top of the decision ledger.` : ""}</span>
    </section>
  );
}

export function OperationTrace({ trace }: OperationTraceProps) {
  const previousLatestId = useRef<string | undefined>(undefined);
  const [arrivedId, setArrivedId] = useState<string | null>(null);
  const latestId = trace?.nodes.at(-1)?.id;

  useEffect(() => {
    if (previousLatestId.current && latestId && previousLatestId.current !== latestId) {
      setArrivedId(latestId);
      const timer = window.setTimeout(() => setArrivedId(null), 900);
      previousLatestId.current = latestId;
      return () => window.clearTimeout(timer);
    }
    previousLatestId.current = latestId;
  }, [latestId]);

  if (!trace) {
    return <section className="detail-section trace-section trace-unavailable"><h2>Operation evidence</h2><p className="section-empty-copy">The operation is available while its evidence record synchronizes with the operations API.</p></section>;
  }
  if (trace.nodes.length === 0) {
    return <section className="detail-section trace-section"><h2>Operation evidence</h2><p className="section-empty-copy">No calls or operational events have been recorded for this operation.</p></section>;
  }

  return (
    <section className="detail-section trace-section trace-comparison" aria-labelledby="trace-heading">
      <header className="trace-comparison-heading">
        <div><h2 id="trace-heading">Operation evidence</h2><p>Append-only calls and state changes, ordered for the operator currently on the case.</p></div>
        <span>{trace.nodes.length} recorded events</span>
      </header>
      <DecisionLedger nodes={trace.nodes} arrivedId={arrivedId} />
    </section>
  );
}
