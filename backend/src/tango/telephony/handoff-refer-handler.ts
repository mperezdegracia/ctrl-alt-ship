export type HandoffContext = {
  escalationId: string;
  sourceCallId: string;
  twilioCallSid: string;
  phone: string;
  active: boolean;
  handoffStatus: string;
};

export class HandoffReferHttpError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

type Dependencies = {
  accountSid: string;
  fromNumber: string;
  baseUrl: string;
  verifySignature(url: string, body: Record<string, string>, signature?: string): boolean;
  find(callId: string): Promise<HandoffContext | null>;
  markFailed(context: HandoffContext, detail: string): Promise<void>;
  log(event: string, fields: Record<string, unknown>): void;
};

const xml = (value: string) => value.replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[c]!);

/** Only signed Twilio requests for an existing durable handoff may dial a person. */
export class HandoffReferHandler {
  constructor(private readonly dependencies: Dependencies) {}

  async handle(request: { url: string; signature?: string; body: unknown; finished: boolean }): Promise<string> {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)
      || Object.values(request.body).some((value) => typeof value !== 'string')) {
      throw new HandoffReferHttpError(400, 'Invalid Twilio form');
    }
    const body = request.body as Record<string, string>;
    if (body.AccountSid !== this.dependencies.accountSid
      || !this.dependencies.verifySignature(request.url, body, request.signature)) {
      throw new HandoffReferHttpError(403, 'Invalid Twilio signature or account');
    }
    const callId = new URL(request.url).searchParams.get('call_record_id') ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callId)) {
      throw new HandoffReferHttpError(400, 'Invalid call record');
    }
    const context = await this.dependencies.find(callId);
    if (!context || body.CallSid !== context.twilioCallSid) {
      throw new HandoffReferHttpError(403, 'Call does not match a durable handoff');
    }
    const fields = { call_record_id: callId, escalation_id: context.escalationId };
    if (request.finished) {
      const status = body.DialCallStatus;
      if (!['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(status ?? '')) {
        throw new HandoffReferHttpError(400, 'Invalid dial result');
      }
      this.dependencies.log('escalation.twilio_dial_finished', {
        ...fields, dial_status: status, dial_call_sid: body.DialCallSid ?? null,
        // A completed telephone leg may also be voicemail, not a human.
        human_answer_confirmed: false,
      });
      if (status !== 'completed') {
        await this.dependencies.markFailed(context, `Twilio human handoff ended with ${status}. Manual review remains open.`);
        return '<Response><Say>We could not connect the operator. Your request remains open for human review.</Say><Hangup/></Response>';
      }
      return '<Response><Hangup/></Response>';
    }
    if (!context.active || !/^\+[1-9]\d{7,14}$/.test(context.phone)
      || !['pending', 'transfer_requested'].includes(context.handoffStatus)
      || ![context.phone, `tel:${context.phone}`].includes(body.ReferTransferTarget ?? '')) {
      throw new HandoffReferHttpError(403, 'Transfer target is not the authorized recipient');
    }
    const action = new URL('/twilio/handoff-finished', this.dependencies.baseUrl);
    action.searchParams.set('call_record_id', callId);
    this.dependencies.log('escalation.twilio_dial_requested', {
      ...fields, target_phone_suffix: context.phone.slice(-4), human_answer_confirmed: false,
    });
    return `<Response><Dial callerId="${xml(this.dependencies.fromNumber)}" timeout="30" action="${xml(action.toString())}" method="POST"><Number>${xml(context.phone)}</Number></Dial></Response>`;
  }
}
