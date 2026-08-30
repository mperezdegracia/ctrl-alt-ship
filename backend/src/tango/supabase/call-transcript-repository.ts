import type { SupabaseClient } from "@supabase/supabase-js";

export class SupabaseCallTranscriptRepository {
  constructor(private readonly client: SupabaseClient) {}

  async record(input: {
    callId: string;
    realtimeCallId: string;
    speaker: "caller" | "tango";
    content: string;
    realtimeItemId?: string;
    realtimeResponseId?: string;
  }): Promise<void> {
    const { error } = await this.client.rpc("record_call_transcript_segment", {
      p_call_id: input.callId,
      p_realtime_call_id: input.realtimeCallId,
      p_speaker: input.speaker,
      p_content: input.content,
      p_realtime_item_id: input.realtimeItemId ?? null,
      p_realtime_response_id: input.realtimeResponseId ?? null,
    });
    if (error) throw error;
  }
}

export class SupabaseEscalationHandoffRepository {
  constructor(private readonly client: SupabaseClient) {}

  async mark(input: {
    escalationId: string;
    sourceCallId: string;
    status: "transfer_requested" | "transfer_failed";
    detail?: string;
  }): Promise<void> {
    const { error } = await this.client.rpc("mark_escalation_handoff", {
      p_escalation_id: input.escalationId,
      p_source_call_id: input.sourceCallId,
      p_handoff_status: input.status,
      p_detail: input.detail ?? null,
    });
    if (error) throw error;
  }
}
