// Collected from Realtime server events, never from model tool arguments.
// Transcripts are audit evidence, not an independent semantic consent classifier.
export type ConfirmationEvidence = Readonly<{
  summary_item_id: string;
  summary_response_id: string;
  summary_transcript: string;
  caller_item_id: string;
  caller_event_id: string;
  caller_transcript: string;
  input_audio_end_ms: number;
}>;
