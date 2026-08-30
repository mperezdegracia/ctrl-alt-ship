"use client";

import { useMemo, useState } from "react";
import type { Commitment } from "@/lib/mock-operations";

type CommitmentEvidenceProps = {
  commitments: Commitment[];
};

function RecordingIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M12 3.75a3 3 0 0 0-3 3v5.5a3 3 0 0 0 6 0v-5.5a3 3 0 0 0-3-3Z" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
      <path d="m8.5 5.9 9.1 5.3a.9.9 0 0 1 0 1.6l-9.1 5.3A.9.9 0 0 1 7.1 17V7a.9.9 0 0 1 1.4-1.1Z" />
    </svg>
  );
}

export function CommitmentEvidence({ commitments }: CommitmentEvidenceProps) {
  const [selectedId, setSelectedId] = useState(commitments[0]?.id);
  const selected = useMemo(
    () => commitments.find((commitment) => commitment.id === selectedId) ?? commitments[0],
    [commitments, selectedId],
  );

  if (!selected) return null;

  const recordingReady = selected.recording.status === "ready" && Boolean(selected.recording.url);

  return (
    <section className="detail-section evidence-section" aria-labelledby="commitments-heading">
      <div className="evidence-heading">
        <div>
          <h2 id="commitments-heading">Commitments</h2>
          <p>Verified decisions and their call evidence. Select a record to inspect its anchor.</p>
        </div>
        <span className="evidence-count">{commitments.length} records</span>
      </div>

      <div className="evidence-layout">
        <ol className="commitment-timeline" aria-label="Commitment timeline">
          {commitments.map((commitment) => {
            const selectedCommitment = commitment.id === selected.id;
            return (
              <li key={commitment.id} className={selectedCommitment ? "is-selected" : undefined}>
                <time dateTime={commitment.occurredAt}>{commitment.timestamp}</time>
                <button
                  type="button"
                  className="commitment-record"
                  onClick={() => setSelectedId(commitment.id)}
                  aria-pressed={selectedCommitment}
                >
                  <span className="commitment-kind">{commitment.kind}</span>
                  <strong>{commitment.title}</strong>
                  <span>{commitment.summary}</span>
                  <small>Evidence at {commitment.checkpoint}</small>
                </button>
              </li>
            );
          })}
        </ol>

        <aside className="evidence-dossier" aria-live="polite" aria-label={`Evidence for ${selected.title}`}>
          <div className="evidence-dossier-heading">
            <div>
              <p className="evidence-label">Evidence anchor</p>
              <h3>{selected.title}</h3>
            </div>
            <span className="commitment-id">{selected.id}</span>
          </div>

          <dl className="evidence-meta">
            <div><dt>Call</dt><dd>{selected.call.label}</dd></div>
            <div><dt>Counterparty</dt><dd>{selected.call.counterparty}</dd></div>
            <div><dt>Direction</dt><dd>{selected.call.direction}</dd></div>
          </dl>

          <blockquote>
            <p>{selected.transcriptExcerpt}</p>
            <footer>Conversation excerpt around the verified action</footer>
          </blockquote>

          {selected.supersedes && (
            <p className="supersedes-note"><span>Supersedes</span>{selected.supersedes}</p>
          )}

          <div className="recording-control">
            <div className="recording-symbol"><RecordingIcon /></div>
            <div>
              <p>Call recording</p>
              <span>Replay from checkpoint {selected.checkpoint}</span>
            </div>
            {recordingReady ? (
              <audio controls preload="metadata" src={selected.recording.url} aria-label={`Recording for ${selected.title}`} />
            ) : (
              <button type="button" className="replay-button" disabled title="A Twilio recording URL will enable replay here.">
                <PlayIcon />
                Recording pending
              </button>
            )}
          </div>
          {!recordingReady && <p className="recording-note">The evidence record is ready; audio appears automatically once its call recording is attached.</p>}
        </aside>
      </div>
    </section>
  );
}
