import assert from "node:assert/strict";

import {
  CallEvidenceRetentionWorker,
  type EvidenceRetentionDb,
} from "../../src/tango/workers/call-evidence-retention-worker";

const callA = "11111111-1111-4111-8111-111111111111";
const callB = "22222222-2222-4222-8222-222222222222";
const callC = "33333333-3333-4333-8333-333333333333";

type RpcCall = { name: string; args?: Record<string, unknown> };

class FakeDb implements EvidenceRetentionDb {
  readonly calls: RpcCall[] = [];
  private claimReturned = false;
  constructor(private readonly jobs = [
    { call_id: callA, transcript_pending: true, recordings: [{ recording_sid: "RE" + "a".repeat(32) }] },
    { call_id: callB, transcript_pending: false, recordings: [{ recording_sid: "RE" + "b".repeat(32) }] },
    { call_id: callC, transcript_pending: false, recordings: [{ recording_sid: "RE" + "c".repeat(32) }] },
  ] as unknown[], private readonly persistFailure = false) {}

  async rpc(name: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: unknown | null }> {
    this.calls.push({ name, args });
    if (name === "claim_call_evidence_retention") {
      if (this.claimReturned) return { data: [], error: null };
      this.claimReturned = true;
      return {
        data: this.jobs,
        error: null,
      };
    }
    if (name === "purge_expired_call_transcripts") return { data: null, error: new Error("transcript unavailable") };
    if (name === "complete_call_recording_deletion" && this.persistFailure) return { data: null, error: new Error("persist failed") };
    return { data: { persisted: true }, error: null };
  }
}

const logger = {
  info: () => undefined,
  error: () => undefined,
};

async function main(): Promise<void> {
const db = new FakeDb();
const deleted: string[] = [];
const worker = new CallEvidenceRetentionWorker(
  db,
  { accountSid: "AC" + "1".repeat(32), authToken: "secret" },
  logger,
  {
    fetch: async (url) => {
      deleted.push(url);
      return new Response(null, { status: url.includes("b") ? 500 : url.includes("c") ? 204 : 404 });
    },
  },
);

assert.equal(await worker.runOnce(), 3);
assert.equal(deleted.length, 3);
assert.equal(db.calls.filter((call) => call.name === "purge_expired_call_transcripts").length, 1);
assert.equal(db.calls.filter((call) => call.name === "complete_call_recording_deletion").length, 3);
assert.deepEqual(db.calls.filter((call) => call.name === "complete_call_recording_deletion").map((call) => call.args?.p_error), [
  null,
  "twilio_delete_http_500",
  null,
]);

const missingDb = new FakeDb();
const missingWorker = new CallEvidenceRetentionWorker(
  missingDb,
  {},
  logger,
  { fetch: async () => { throw new Error("network must not be called"); } },
);
assert.equal(await missingWorker.runOnce(), 3);
assert.equal(missingDb.calls.filter((call) => call.name === "complete_call_recording_deletion").length, 3);
assert.ok(missingDb.calls.filter((call) => call.name === "complete_call_recording_deletion")
  .every((call) => call.args?.p_error === "twilio_credentials_missing"));

let malformedDeletes = 0;
const malformedDb = new FakeDb([{ call_id: callA, transcript_pending: false, recordings: [{ recording_sid: "bad" }] }]);
const malformedWorker = new CallEvidenceRetentionWorker(malformedDb, { accountSid: "AC", authToken: "token" }, logger, {
  fetch: async () => { malformedDeletes += 1; return new Response(null, { status: 204 }); },
});
await assert.rejects(() => malformedWorker.runOnce(), /Invalid retention claim job/);
assert.equal(malformedDeletes, 0);

const timeoutDb = new FakeDb([{ call_id: callA, transcript_pending: false, recordings: [{ recording_sid: "RE" + "d".repeat(32) }] }]);
const timeoutWorker = new CallEvidenceRetentionWorker(timeoutDb, { accountSid: "AC", authToken: "token" }, logger, {
  deleteTimeoutMs: 1,
  fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true });
  }),
});
await timeoutWorker.runOnce();
assert.equal(timeoutDb.calls.at(-1)?.args?.p_error, "twilio_delete_timeout");

const persistDb = new FakeDb([{ call_id: callA, transcript_pending: false, recordings: [{ recording_sid: "RE" + "e".repeat(32) }] }], true);
const persistWorker = new CallEvidenceRetentionWorker(persistDb, { accountSid: "AC", authToken: "token" }, logger, {
  fetch: async () => new Response(null, { status: 204 }),
});
await persistWorker.runOnce();
assert.equal(persistDb.calls.filter((call) => call.name === "complete_call_recording_deletion").length, 1);

let releaseClaim!: () => void;
const overlapDb: EvidenceRetentionDb = {
  rpc: async (name) => {
    if (name === "claim_call_evidence_retention") await new Promise<void>((resolve) => { releaseClaim = resolve; });
    return { data: [], error: null };
  },
};
const overlapWorker = new CallEvidenceRetentionWorker(overlapDb, {}, logger);
const firstRun = overlapWorker.runOnce();
assert.equal(await overlapWorker.runOnce(), 0);
releaseClaim();
await firstRun;

console.log("Evidence retention worker harness passed: partial failures, 204/404 semantics, HTTP errors and missing credentials.");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
