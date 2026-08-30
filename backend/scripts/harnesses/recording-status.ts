import assert from "node:assert/strict";
import {
  RecordingStatusHandler,
  RecordingStatusHttpError,
  type RecordingStatusPersistence,
} from "../../src/tango/telephony/recording-status-handler";

const callSid = "CA1234567890abcdef1234567890abcdef";
const recordingSid = "RE1234567890abcdef1234567890abcdef";
const body = {
  AccountSid: "AC1234567890abcdef1234567890abcdef",
  CallSid: callSid,
  RecordingSid: recordingSid,
  RecordingStatus: "completed",
};

async function expectHttpError(action: Promise<unknown>, statusCode: 400 | 403 | 500): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof RecordingStatusHttpError
    && error.statusCode === statusCode);
}

async function main(): Promise<void> {
  let resolvePersistence: ((value: { persisted: true; expired: boolean }) => void) | undefined;
  let called = false;
  const persistence: RecordingStatusPersistence = {
    recordStatus: async () => {
      called = true;
      return new Promise((resolve) => { resolvePersistence = resolve; });
    },
  };
  const handler = new RecordingStatusHandler({
    repository: persistence,
    expectedAccountSid: body.AccountSid,
    verifySignature: (url, _signedBody, signature) => url.startsWith("https://example.test/recording")
      && signature === "valid",
  });

  let settled = false;
  const pending = handler.handle({ url: "https://example.test/recording?x=1", signature: "valid", body })
    .then((result) => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(called, true);
  assert.equal(settled, false, "must not complete before persistence resolves");
  resolvePersistence?.({ persisted: true, expired: false });
  assert.deepEqual(await pending, { persisted: true, expired: false });

  const { RecordingSid: _completedSid, ...missingCompletedSid } = body;
  await expectHttpError(handler.handle({ url: "https://example.test/recording?x=1", signature: "valid", body: missingCompletedSid }), 400);
  await expectHttpError(handler.handle({ url: "https://example.test/recording", signature: "bad", body }), 403);
  await expectHttpError(handler.handle({ url: "https://example.test/recording", signature: "valid", body: { ...body, AccountSid: "ACother" } }), 403);
  await expectHttpError(handler.handle({ url: "ftp://example.test/recording", signature: "valid", body }), 400);
  await expectHttpError(handler.handle({ url: "not a url", signature: "valid", body }), 400);
  await expectHttpError(handler.handle({ url: "https://example.test/recording", signature: "valid", body: [body] }), 400);
  await expectHttpError(handler.handle({ url: "https://example.test/recording", signature: "valid", body: { ...body, Extra: 42 } }), 400);
  await expectHttpError(handler.handle({ url: "https://example.test/recording", signature: "valid", body: { ...body, AccountSid: "ACnot-a-sid" } }), 403);
  await expectHttpError(handler.handle({ url: "https://example.test/recording?x=1", signature: "valid", body: { ...body, CallSid: "CAinvalid" } }), 400);
  await expectHttpError(handler.handle({ url: "https://example.test/recording?x=1", signature: "valid", body: { ...body, RecordingSid: "REinvalid" } }), 400);
  await expectHttpError(handler.handle({ url: "https://example.test/recording?x=1", signature: "valid", body: { ...body, RecordingStatus: "processing" } }), 400);
  const absentCalls: Array<{ p_recording_sid: string | null; p_status: string }> = [];
  const absentHandler = new RecordingStatusHandler({
    repository: { recordStatus: async (params) => {
      absentCalls.push({ p_recording_sid: params.p_recording_sid, p_status: params.p_status });
      return { persisted: true, expired: true };
    } },
    expectedAccountSid: body.AccountSid,
    verifySignature: () => true,
  });
  assert.deepEqual(await absentHandler.handle({
    url: "https://example.test/recording", signature: "valid",
    body: { AccountSid: body.AccountSid, CallSid: callSid, RecordingStatus: "absent" },
  }), { persisted: true, expired: true });
  assert.deepEqual(absentCalls, [{ p_recording_sid: null, p_status: "absent" }]);

  const failingHandler = new RecordingStatusHandler({
    repository: { recordStatus: async () => { throw new Error("missing call"); } },
    expectedAccountSid: body.AccountSid,
    verifySignature: () => true,
  });
  await expectHttpError(failingHandler.handle({ url: "https://example.test/recording", signature: "valid", body }), 500);

  const invalidResultHandler = new RecordingStatusHandler({
    repository: { recordStatus: async () => ({ persisted: false, expired: false }) as never },
    expectedAccountSid: body.AccountSid,
    verifySignature: () => true,
  });
  await expectHttpError(invalidResultHandler.handle({ url: "https://example.test/recording", signature: "valid", body }), 500);

  const invalidExpiredHandler = new RecordingStatusHandler({
    repository: { recordStatus: async () => ({ persisted: true, expired: null }) as never },
    expectedAccountSid: body.AccountSid,
    verifySignature: () => true,
  });
  await expectHttpError(invalidExpiredHandler.handle({ url: "https://example.test/recording", signature: "valid", body }), 500);
}

void main();
