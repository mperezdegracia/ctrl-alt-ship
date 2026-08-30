import type { CSSProperties } from "react";

import { formatDateTime } from "@/lib/dashboard-api";
import type { DashboardOperationDossier } from "@/lib/dashboard-api";

type OperationTraceProps = {
  trace: DashboardOperationDossier["trace"];
};

type OperationTraceData = NonNullable<DashboardOperationDossier["trace"]>;

function nodeClassName(node: OperationTraceData["nodes"][number]): string {
  const classes = ["trace-node"];
  if (node.kind === "call_started") classes.push("is-call-start");
  if (node.kind === "call_ended") classes.push("is-call-end");
  if (node.kind === "event") classes.push("is-event");
  if (node.sourceCall) classes.push("has-call-origin");
  if (node.changes.length > 0) classes.push("has-changes");
  return classes.join(" ");
}

export function OperationTrace({ trace }: OperationTraceProps) {
  if (!trace) {
    return (
      <section className="detail-section trace-section trace-unavailable" aria-labelledby="trace-heading">
        <div className="trace-heading">
          <div>
            <h2 id="trace-heading">Operation trace</h2>
            <p>The operation record is available. Its event trace is still synchronizing with the operations API.</p>
          </div>
          <span>Trace syncing</span>
        </div>
      </section>
    );
  }

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
    "--trace-min-width": `${6.5 + (trace.lanes.length * 19)}rem`,
    "--trace-mobile-min-width": `${5.25 + (trace.lanes.length * 15.5)}rem`,
  } as CSSProperties;
  const lanePositions = new Map(trace.lanes.map((lane, index) => [lane.id, index]));

  return (
    <section className="detail-section trace-section" aria-labelledby="trace-heading">
      <div className="trace-heading">
        <div>
          <h2 id="trace-heading">Operation trace</h2>
            <p>Read top to bottom. The operation record stays on the left; each call opens a branch to the right. A return line marks what that call changed.</p>
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
                "--trace-return-width": `${(node.sourceCall?.branchDepth ?? 0) * 100}%`,
              } as CSSProperties;
              return (
                <li className="trace-row" key={node.id}>
                  <time dateTime={node.occurredAt}>{formatDateTime(node.occurredAt)}</time>
                  {trace.lanes.map((lane, index) => <span className="trace-spine" key={lane.id} style={{ gridColumn: index + 2 }} aria-hidden="true" />)}
                  <div className={nodeClassName(node)} style={nodeStyle}>
                    <span className="trace-node-kind">{node.kind === "event" ? "Operation state changed" : node.kind === "call_started" ? "Call branch opened" : "Call branch closed"}</span>
                    <strong>{node.title}</strong>
                    {node.detail && <p>{node.detail}</p>}
                    {node.sourceCall && <span className="trace-node-origin">Changed during {node.sourceCall.description.toLocaleLowerCase()} with {node.sourceCall.label}</span>}
                    {node.changes.length > 0 && (
                      <dl className="trace-changes">
                        {node.changes.map((change) => (
                          <div key={change.label}>
                            <dt>{change.label}</dt>
                            <dd>{change.before && <span>{change.before}</span>}<strong>{change.after}</strong></dd>
                          </div>
                        ))}
                      </dl>
                    )}
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
