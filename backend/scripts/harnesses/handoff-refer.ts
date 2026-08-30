import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { HandoffReferHandler, HandoffReferHttpError, type HandoffContext } from '../../src/tango/telephony/handoff-refer-handler';

// Fixture credentials only; this harness never sends HTTP or makes phone calls.
Object.assign(process.env, {
  TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'fixture-token',
  TWILIO_FROM_NUMBER: '+14155550100', PUBLIC_BASE_URL: 'https://voice.example.com',
  OPENAI_PROJECT_ID: 'proj_fixture', OPENAI_API_KEY: 'fixture-key', OPENAI_WEBHOOK_SECRET: 'fixture-secret',
  SUPABASE_URL: 'https://database.example.com', SUPABASE_SECRET_KEY: 'fixture',
  SUPABASE_PUBLISHABLE_KEY: 'fixture', EMAIL_DELIVERY_MODE: 'preview',
});
const { buildOutboundTwiml, verifyTwilioSignature } = require('../../src/tango/telephony/twilio-outbound');
const callId = '00000000-0000-0000-0000-000000000001';
const callSid = `CA${'2'.repeat(32)}`;
const baseUrl = process.env.PUBLIC_BASE_URL!;
const url = `${baseUrl}/twilio/handoff-refer?call_record_id=${callId}`;
let context: HandoffContext | null = {
  sourceCallId: callId, escalationId: 'esc-fixture', twilioCallSid: callSid,
  phone: '+5491100000000', active: true, handoffStatus: 'pending',
};
let lookups = 0;
const failures: string[] = [];
const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
const handler = new HandoffReferHandler({
  accountSid: process.env.TWILIO_ACCOUNT_SID!, fromNumber: process.env.TWILIO_FROM_NUMBER!, baseUrl,
  verifySignature: verifyTwilioSignature,
  find: async (id) => { lookups++; return id === callId ? context : null; },
  markFailed: async (_context, detail) => { failures.push(detail); },
  log: (event, fields) => { logs.push({ event, fields }); },
});
const body = { AccountSid: process.env.TWILIO_ACCOUNT_SID!, CallSid: callSid, ReferTransferTarget: 'tel:+5491100000000' };
function signed(value: Record<string, string>, finished = false) {
  const target = finished ? url.replace('handoff-refer', 'handoff-finished') : url;
  const data = target + Object.keys(value).sort().map(key => key + value[key]).join('');
  return { url: target, body: value, finished, signature: createHmac('sha1', 'fixture-token').update(data).digest('base64') };
}
const forbidden = (error: unknown) => error instanceof HandoffReferHttpError && error.statusCode === 403;
async function main() {
  const initial = buildOutboundTwiml(callId);
  assert.ok(initial.includes(`referUrl="${url}"`), 'Outbound SIP must enable REFER callbacks');
  assert.match(initial, /record="record-from-answer-dual"/);
  assert.match(initial, /X-Tango-Call-Id=/);
  await assert.rejects(handler.handle({ ...signed(body), signature: 'bad' }), forbidden);
  assert.equal(lookups, 0, 'Do not look up or dial destinations before authenticating');
  await assert.rejects(handler.handle(signed({ ...body, AccountSid: `AC${'3'.repeat(32)}` })), forbidden);
  await assert.rejects(handler.handle(signed({ ...body, CallSid: `CA${'3'.repeat(32)}` })), forbidden);
  await assert.rejects(handler.handle(signed({ ...body, ReferTransferTarget: 'tel:+14155550999' })), forbidden);
  assert.match(failures.at(-1)!, /did not match the authorized recipient/);
  const tampered = signed(body);
  await assert.rejects(handler.handle({ ...tampered, body: { ...body, ReferTransferTarget: 'tel:+14155550999' } }), forbidden);
  const result = await handler.handle(signed(body));
  assert.match(result, /<Number>\+5491100000000<\/Number>/);
  assert.match(result, /callerId="\+14155550100"/);
  assert.match(result, /timeout="30"/);
  assert.ok(result.includes(`${baseUrl}/twilio/handoff-finished?call_record_id=${callId}`));
  assert.equal(await handler.handle(signed({ ...body, ReferTransferTarget: '+5491100000000' })), result);
  assert.equal(await handler.handle(signed({ ...body, ReferTransferTarget: '<tel:+5491100000000;user=phone>' })), result);
  await assert.rejects(handler.handle(signed({ ...body, ReferTransferTarget: 'tel:+5491100000000?unexpected=parameter' })), forbidden);
  context!.active = false;
  await assert.rejects(handler.handle(signed(body)), forbidden);
  context!.active = true;
  context!.handoffStatus = 'transfer_failed';
  await assert.rejects(handler.handle(signed(body)), forbidden);
  context!.handoffStatus = 'transfer_requested';
  for (const status of ['busy', 'no-answer', 'failed', 'canceled']) {
    const failure = await handler.handle(signed({ ...body, DialCallStatus: status }, true));
    assert.match(failure, /could not connect/);
    assert.match(failures.at(-1)!, new RegExp(status));
    assert.doesNotMatch(failure, /<Dial/);
  }
  assert.equal(await handler.handle(signed({ ...body, DialCallStatus: 'completed' }, true)), '<Response><Hangup/></Response>');
  assert.equal(failures.length, 6, 'Completed leg must not be marked failed');
  assert.equal(logs.at(-1)?.fields.human_answer_confirmed, false, 'Do not confuse answered or voicemail with a human');
  context = null;
  await assert.rejects(handler.handle(signed(body)), forbidden);
  console.log('Handoff REFER harness passed: outbound wiring, real signature verification, call/recipient isolation, and dial failure handling. No network or calls.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
