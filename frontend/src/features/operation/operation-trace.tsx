import type { CSSProperties } from "react";

import { formatDateTime } from "@/lib/dashboard-api";
import type { DashboardOperationDossier } from "@/lib/dashboard-api";

type OperationTraceProps = {
  trace: DashboardOperationDossier["trace"];
};

function nodeClassName(kind: DashboardOperationDossier["trace"]["nodes"][number]["kind"]): string {
  if (kind === "call_started") return "trace-node is-call-start";
  if (kind === "call_ended") return "trace-node is-call-end";
  return "trace-node is-event";
}

export function OperationTrace({ trace }: OperationTraceProps) {
  if (trace.nodes.length === 0) {
    return (
      <section className="detail-section trace-section" aria-labelledby="trace-heading">
        <div className="trace-heading">
          <div>
            <h2 id="trace-heading">Operation trace</h2>
            <p>The causal record will appear as Tango persists calls and decisions.</p>
          </div>
        </div>
        <p className="section-empty-copy">No calls or operational events have been recorded for this operation.</p>
      </section>
    );
  }

  const boardStyle = {
    "--trace-lanes": trace.lanes.length,
    "--trace-min-width": `${6.5 + (trace.lanes.length * 13)}rem`,
    "--trace-mobile-min-width": `${5.25 + (trace.lanes.length * 12.5)}rem`,
  } as CSSProperties;
  const lanePositions = new Map(trace.lanes.map((lane, index) => [lane.id, index]));

  return (
    <section className="detail-section trace-section" aria-labelledby="trace-heading">
      <div className="trace-heading">
        <div>
          <h2 id="trace-heading">Operation trace</h2>
          <p>Calls branch from the durable operation record; decisions remain tied to the call that produced them.</p>
        </div>
        <span>{trace.nodes.length} recorded events</span>
      </div>
      <div className="trace-scroll">
        <div className="trace-board" style={boardStyle}>
          <div className="trace-lane-headings" aria-hidden="true">
            {trace.lanes.map((lane) => (
              <div className={`trace-lane-heading is-${lane.kind}`} key={lane.id}>
                <strong>{lane.label}</strong>
                <span>{lane.description}</span>
              </div>
            ))}
          </div>
          <ol className="trace-rows" aria-label="Operation event trace">
            {trace.nodes.map((node) => {
              const lanePosition = lanePositions.get(node.laneId) ?? 0;
              const nodeStyle = {
                "--trace-lane": lanePosition + 2,
                "--trace-branch-width": `${node.branchDepth * 100}%`,
                "--trace-branch-offset": `${node.branchDepth * -100}%`,
              } as CSSProperties;
              return (
                <li className="trace-row" key={node.id}>
                  <time dateTime={node.occurredAt}>{formatDateTime(node.occurredAt)}</time>
                  {trace.lanes.map((lane, index) => <span className="trace-spine" key={lane.id} style={{ gridColumn: index + 2 }} aria-hidden="true" />)}
                  <div className={nodeClassName(node.kind)} style={nodeStyle}>
                    <span className="trace-node-kind">{node.kind === "event" ? "Recorded decision" : node.kind === "call_started" ? "Call opened" : "Call closed"}</span>
                    <strong>{node.title}</strong>
                    {node.detail && <p>{node.detail}</p>}
                    {node.recordingCheckpoint !== null && <small>Evidence checkpoint {node.recordingCheckpoint.toFixed(2)}s</small>}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}
