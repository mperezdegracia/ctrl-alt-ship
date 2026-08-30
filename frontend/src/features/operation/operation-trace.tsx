"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { formatDateTime } from "@/lib/dashboard-api";
import type { DashboardOperationDossier } from "@/lib/dashboard-api";

type OperationTraceProps = { trace: DashboardOperationDossier["trace"] };
type TraceData = NonNullable<DashboardOperationDossier["trace"]>;
type TraceNode = TraceData["nodes"][number];

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

function StudyHeading({ id, title, copy }: { id: string; title: string; copy: string }) {
  return <header className="trace-study-heading"><h3 id={id}>{title}</h3><p>{copy}</p></header>;
}

function DecisionLedger({ nodes, arrivedId }: { nodes: TraceNode[]; arrivedId: string | null }) {
  return (
    <section className="trace-study trace-study-ledger" aria-labelledby="decision-ledger-title">
      <StudyHeading id="decision-ledger-title" title="Decision ledger" copy="One chronological record: what changed, when it became durable, and the call that produced it." />
      <ol className="decision-ledger" aria-label="Decision ledger study">
        {nodes.map((node) => (
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
    </section>
  );
}

function CallDocket({ trace, arrivedId }: { trace: TraceData; arrivedId: string | null }) {
  const operationEvents = trace.nodes.filter((node) => node.laneId === "operation");
  const callLanes = trace.lanes.filter((lane) => lane.kind === "call");
  return (
    <section className="trace-study trace-study-docket" aria-labelledby="call-docket-title">
      <StudyHeading id="call-docket-title" title="Call docket" copy="Conversations are the filing unit; durable operation effects remain visible alongside their source." />
      {operationEvents.length > 0 && <div className="call-docket-operation">
        <h4>Operation record</h4>
        <ol>
          {operationEvents.map((node) => <li key={node.id} className={node.id === arrivedId ? "is-new-evidence" : undefined}><time dateTime={node.occurredAt}>{formatDateTime(node.occurredAt)}</time><div><strong>{node.title}</strong>{node.detail && <p>{node.detail}</p>}<NodeChanges node={node} /><EvidenceSource node={node} /></div></li>)}
        </ol>
      </div>}
      <ol className="call-dockets" aria-label="Call docket study">
        {callLanes.map((lane) => {
          const callNodes = trace.nodes.filter((node) => node.laneId === lane.id);
          return (
            <li key={lane.id}>
              <header><div><h4>{lane.label}</h4><p>{lane.description}</p></div><span>{callNodes.length} evidence {callNodes.length === 1 ? "entry" : "entries"}</span></header>
              <ol>
                {callNodes.map((node) => <li key={node.id} className={node.id === arrivedId ? "is-new-evidence" : undefined}><time dateTime={node.occurredAt}>{formatDateTime(node.occurredAt)}</time><div><span>{eventKind(node)}</span><strong>{node.title}</strong>{node.detail && <p>{node.detail}</p>}<NodeChanges node={node} /><EvidenceSource node={node} /></div></li>)}
              </ol>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function AuditSplit({ nodes, arrivedId }: { nodes: TraceNode[]; arrivedId: string | null }) {
  const [selectedId, setSelectedId] = useState(nodes.at(-1)?.id);
  const selected = useMemo(() => nodes.find((node) => node.id === selectedId) ?? nodes.at(-1), [nodes, selectedId]);
  if (!selected) return null;
  return (
    <section className="trace-study trace-study-audit" aria-labelledby="audit-split-title">
      <StudyHeading id="audit-split-title" title="Audit split view" copy="Scan the record on the left; select one entry to inspect the exact evidence on the right." />
      <div className="audit-split">
        <ol className="audit-rail" aria-label="Audit split timeline study">
          {nodes.map((node) => {
            const selectedNode = node.id === selected.id;
            return <li key={node.id} className={node.id === arrivedId ? "is-new-evidence" : undefined}>
              <button type="button" onClick={() => setSelectedId(node.id)} aria-pressed={selectedNode}>
                <time dateTime={node.occurredAt}>{formatDateTime(node.occurredAt)}</time>
                <span>{eventKind(node)}</span>
                <strong>{node.title}</strong>
              </button>
            </li>;
          })}
        </ol>
        <aside className="audit-focus" aria-live="polite" aria-label={`Evidence for ${selected.title}`}>
          <span>{eventKind(selected)}</span>
          <h4>{selected.title}</h4>
          <time dateTime={selected.occurredAt}>{formatDateTime(selected.occurredAt)}</time>
          {selected.detail && <p>{selected.detail}</p>}
          <NodeChanges node={selected} />
          <EvidenceSource node={selected} />
        </aside>
      </div>
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
        <div><h2 id="trace-heading">Operation evidence</h2><p>The same append-only calls and events, shown three ways for comparison.</p></div>
        <span>{trace.nodes.length} recorded events</span>
      </header>
      <DecisionLedger nodes={trace.nodes} arrivedId={arrivedId} />
      <CallDocket trace={trace} arrivedId={arrivedId} />
      <AuditSplit nodes={trace.nodes} arrivedId={arrivedId} />
    </section>
  );
}
