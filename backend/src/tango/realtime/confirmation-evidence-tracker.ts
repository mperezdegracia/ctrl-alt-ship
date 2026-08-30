import type { RealtimeServerEvent } from "openai/resources/realtime/realtime";
import type { ConfirmationEvidence } from "../../domain/confirmation-evidence";

// `played` denotes a drained server output buffer, not proof of human hearing.
type Summary = { itemId: string; responseId: string; transcript: string; completed: boolean; played: boolean; invalid: boolean };
type CallerTurn = { itemId: string; summary?: Summary; transcript?: string; eventId?: string; audioEndMs?: number };

/** Per-call audit capture. No model-supplied transcript or consent boolean.
 * Semantic approval remains the conversational agent's responsibility.
 */
export class ConfirmationEvidenceTracker {
  private summary?: Summary;
  private caller?: CallerTurn;
  private readonly responses = new Map<string, CallerTurn | undefined>();

  observe(event: RealtimeServerEvent): void {
    switch (event.type) {
      case "response.created":
        if (event.response.id) {
          this.responses.set(event.response.id, this.caller);
          // Bound memory for long calls. Old completed invocations replay in SQL.
          if (this.responses.size > 32) this.responses.delete(this.responses.keys().next().value!);
        }
        break;
      case "response.output_audio_transcript.done":
        // A generated transcript is not evidence of playback by itself.
        this.summary = { itemId: event.item_id, responseId: event.response_id,
          transcript: event.transcript, completed: false, played: false, invalid: false };
        break;
      case "response.done":
        if (this.summary && this.summary.responseId === event.response.id) {
          this.summary.completed = event.response.status === "completed";
          if (!this.summary.completed) this.summary.invalid = true;
        }
        break;
      case "output_audio_buffer.stopped":
        if (this.summary?.responseId === event.response_id) this.summary.played = true;
        break;
      case "output_audio_buffer.started":
        if (this.summary?.responseId !== event.response_id) this.summary = undefined;
        break;
      case "output_audio_buffer.cleared":
        if (this.summary?.responseId === event.response_id) this.summary.invalid = true;
        if (this.caller?.summary?.responseId === event.response_id) this.caller.summary.invalid = true;
        break;
      case "conversation.item.truncated":
      case "conversation.item.deleted":
        if (this.summary?.itemId === event.item_id) this.summary.invalid = true;
        if (this.caller?.summary?.itemId === event.item_id) this.caller.summary.invalid = true;
        break;
      case "input_audio_buffer.speech_started": {
        const summary = this.summary;
        this.caller = { itemId: event.item_id,
          summary: summary?.completed && summary.played && !summary.invalid ? { ...summary } : undefined };
        // One summary can authorize at most its immediately following caller turn.
        this.summary = undefined;
        break;
      }
      case "input_audio_buffer.speech_stopped":
        if (this.caller?.itemId === event.item_id) this.caller.audioEndMs = event.audio_end_ms;
        break;
      case "conversation.item.input_audio_transcription.completed":
        // ASR may finish out of order. Never replace the current turn with an old yes.
        if (this.caller?.itemId === event.item_id) {
          this.caller.transcript = event.transcript;
          this.caller.eventId = event.event_id;
        }
        break;
      case "conversation.item.input_audio_transcription.failed":
        if (this.caller?.itemId === event.item_id) this.caller.transcript = undefined;
        break;
    }
  }

  capture(responseId: string): ConfirmationEvidence | undefined {
    const caller = this.responses.get(responseId);
    const summary = caller?.summary;
    if (!caller || caller !== this.caller || !summary || summary.invalid || !summary.transcript.trim()
      || !caller.transcript?.trim() || !caller.eventId || !Number.isSafeInteger(caller.audioEndMs)
      || caller.audioEndMs! < 0) return undefined;
    return Object.freeze({ summary_item_id: summary.itemId, summary_response_id: summary.responseId,
      summary_transcript: summary.transcript, caller_item_id: caller.itemId, caller_event_id: caller.eventId,
      caller_transcript: caller.transcript, input_audio_end_ms: caller.audioEndMs! });
  }

  diagnostics(responseId: string) {
    const caller = this.responses.get(responseId);
    const summary = caller?.summary;
    const reason = !caller ? "response_without_caller_turn"
      : caller !== this.caller ? "caller_turn_superseded"
      : !summary ? "no_eligible_summary_before_caller"
      : summary.invalid ? "summary_interrupted_or_removed"
      : !summary.transcript.trim() ? "summary_transcript_missing"
      : !caller.transcript?.trim() || !caller.eventId ? "caller_transcript_missing"
      : !Number.isSafeInteger(caller.audioEndMs) || caller.audioEndMs! < 0 ? "caller_audio_checkpoint_missing"
      : "ready";
    return {
      available: reason === "ready", reason,
      response_id: responseId,
      summary_response_completed: summary?.completed ?? false,
      server_output_buffer_drained: summary?.played ?? false,
      caller_transcript_present: Boolean(caller?.transcript?.trim()),
    };
  }

  invalidate(): void {
    this.summary = undefined;
    if (this.caller) this.caller.summary = undefined;
    this.responses.clear();
  }
}
