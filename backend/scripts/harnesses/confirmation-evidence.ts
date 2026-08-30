import assert from "node:assert/strict";
import type { RealtimeServerEvent } from "openai/resources/realtime/realtime";
import { ConfirmationEvidenceTracker } from "../../src/tango/realtime/confirmation-evidence-tracker";

// Server-event fixtures only: no OpenAI requests, database or real audio.
function fixture() {
  const tracker = new ConfirmationEvidenceTracker();
  const send = (event: object) => tracker.observe({ event_id: "event-test", ...event } as RealtimeServerEvent);
  const summary = (completed = true, played = true) => {
    send({ type: "response.output_audio_transcript.done", item_id: "summary", response_id: "summary-response", transcript: "Full operation, cap, windows and payment terms. Do you confirm?", content_index: 0, output_index: 0 });
    send({ type: "response.done", response: { id: "summary-response", status: completed ? "completed" : "cancelled" } });
    if (played) send({ type: "output_audio_buffer.stopped", response_id: "summary-response" });
  };
  const caller = (transcribe = true) => {
    send({ type: "input_audio_buffer.speech_started", item_id: "caller", audio_start_ms: 12000 });
    send({ type: "input_audio_buffer.speech_stopped", item_id: "caller", audio_end_ms: 14000 });
    if (transcribe) transcript("caller", "Yes, I confirm.");
    send({ type: "response.created", response: { id: "tool-response" } });
  };
  const transcript = (item: string, text: string) => send({ type: "conversation.item.input_audio_transcription.completed", item_id: item, transcript: text, content_index: 0, usage: { type: "duration", seconds: 2 } });
  return { tracker, send, summary, caller, transcript };
}

const ok = fixture();
assert.equal(ok.tracker.capture("unknown"), undefined);
assert.equal(ok.tracker.diagnostics("unknown").reason, "response_without_caller_turn");
ok.summary(); ok.caller();
const captured = ok.tracker.capture("tool-response")!;
assert.equal(captured.caller_transcript, "Yes, I confirm.");
assert.equal(captured.input_audio_end_ms, 14000);
assert.equal(captured.summary_item_id, "summary");
assert.ok(Object.isFrozen(captured));
assert.deepEqual(ok.tracker.diagnostics("tool-response"), {
  available: true, reason: "ready", response_id: "tool-response",
  summary_response_completed: true, server_output_buffer_drained: true, caller_transcript_present: true,
});
assert.doesNotMatch(JSON.stringify(ok.tracker.diagnostics("tool-response")), /Full operation|Yes, I confirm/);
// An assistant preamble from the tool response cannot replace the actual readback.
ok.send({ type: "response.output_audio_transcript.done", item_id: "preamble", response_id: "tool-response", transcript: "Saving now." });
assert.deepEqual(ok.tracker.capture("tool-response"), captured);
ok.transcript("older-item", "yes from a previous turn");
assert.deepEqual(ok.tracker.capture("tool-response"), captured);
ok.tracker.invalidate();
assert.equal(ok.tracker.capture("tool-response"), undefined, "Edits or failures invalidate old consent evidence");

for (const [complete, played] of [[false, false], [false, true], [true, false]]) {
  const f = fixture(); f.summary(complete, played); f.caller();
  assert.equal(f.tracker.capture("tool-response"), undefined, "Require completed response AND drained SIP playback");
  assert.equal(f.tracker.diagnostics("tool-response").reason, "no_eligible_summary_before_caller");
}
const interrupted = fixture(); interrupted.summary(true, false); interrupted.caller();
interrupted.send({ type: "output_audio_buffer.stopped", response_id: "summary-response" });
assert.equal(interrupted.tracker.capture("tool-response"), undefined, "Playback finishing after caller starts is not sufficient");

for (const event of [
  { type: "conversation.item.truncated", item_id: "summary", audio_end_ms: 100, content_index: 0 },
  { type: "conversation.item.deleted", item_id: "summary" },
  { type: "output_audio_buffer.cleared", response_id: "summary-response" },
]) {
  const f = fixture(); f.summary(); f.caller(); f.send(event);
  assert.equal(f.tracker.capture("tool-response"), undefined, "Late interruption invalidates pinned summary");
}
const late = fixture(); late.summary(); late.caller(false);
assert.equal(late.tracker.capture("tool-response"), undefined);
assert.equal(late.tracker.diagnostics("tool-response").reason, "caller_transcript_missing");
late.transcript("older-item", "yes");
assert.equal(late.tracker.capture("tool-response"), undefined);
late.transcript("caller", "Sí, confirmo.");
assert.equal(late.tracker.capture("tool-response")?.caller_transcript, "Sí, confirmo.");
late.send({ type: "conversation.item.input_audio_transcription.failed", item_id: "caller" });
assert.equal(late.tracker.capture("tool-response"), undefined);

const next = fixture(); next.summary(); next.caller();
next.send({ type: "input_audio_buffer.speech_started", item_id: "new-caller", audio_start_ms: 15000 });
assert.equal(next.tracker.capture("tool-response"), undefined, "Do not confirm from a superseded caller turn");
next.send({ type: "input_audio_buffer.speech_stopped", item_id: "new-caller", audio_end_ms: 16000 });
next.transcript("new-caller", "yes");
next.send({ type: "response.created", response: { id: "next-response" } });
assert.equal(next.tracker.capture("next-response"), undefined, "No second confirmation without another complete summary");

const empty = fixture(); empty.summary(); empty.caller(); empty.transcript("caller", " ");
assert.equal(empty.tracker.capture("tool-response"), undefined);
const isolated = fixture(); isolated.caller();
assert.equal(isolated.tracker.capture("tool-response"), undefined, "No cross-call state");
console.log("Confirmation evidence harness passed: playback, interruptions, turn correlation, delayed ASR and invalidation (no network or PostgreSQL).");
