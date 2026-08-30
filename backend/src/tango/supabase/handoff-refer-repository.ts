import type { SupabaseClient } from '@supabase/supabase-js';
import type { HandoffContext } from '../telephony/handoff-refer-handler';

export class HandoffReferRepository {
  constructor(private readonly client: SupabaseClient) {}

  async find(callId: string): Promise<HandoffContext | null> {
    const call = await this.client.from('calls').select('twilio_call_sid')
      .eq('id', callId).eq('direction', 'outbound').maybeSingle();
    if (call.error) throw call.error;
    if (!call.data?.twilio_call_sid) return null;
    const escalation = await this.client.from('escalations')
      .select('id,handoff_recipient_id,handoff_status').eq('source_call_id', callId)
      .order('started_at', { ascending: false }).limit(1).maybeSingle();
    if (escalation.error) throw escalation.error;
    if (!escalation.data?.handoff_recipient_id) return null;
    const recipient = await this.client.from('handoff_recipients').select('phone,active')
      .eq('id', escalation.data.handoff_recipient_id).maybeSingle();
    if (recipient.error) throw recipient.error;
    if (!recipient.data) return null;
    return {
      escalationId: escalation.data.id, sourceCallId: callId,
      twilioCallSid: call.data.twilio_call_sid, phone: recipient.data.phone,
      active: recipient.data.active, handoffStatus: escalation.data.handoff_status,
    };
  }
}
