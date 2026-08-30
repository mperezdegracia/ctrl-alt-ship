import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { matchEvidenceEvents, type EvidenceEvent, type EvidenceSegment } from "../../src/domain/call-evidence";

// No real credentials or network: all database requests below use a fake fetch.
Object.assign(process.env, {
  TWILIO_ACCOUNT_SID: "fixture", TWILIO_AUTH_TOKEN: "fixture", TWILIO_FROM_NUMBER: "+14155550100",
  OPENAI_API_KEY: "fixture", OPENAI_WEBHOOK_SECRET: "fixture", SUPABASE_URL: "https://fixture.example.com",
  SUPABASE_SECRET_KEY: "fixture", SUPABASE_PUBLISHABLE_KEY: "fixture", EMAIL_DELIVERY_MODE: "preview",
});
const { getDashboardCallEvidence } = require("../../src/tango/supabase/dashboard") as typeof import("../../src/tango/supabase/dashboard");
const { requireDashboardAuth } = require("../../src/http/middleware/require-dashboard-auth") as typeof import("../../src/http/middleware/require-dashboard-auth");
const at = (seconds: number) => new Date(Date.UTC(2026, 7, 30, 12, 0, seconds)).toISOString();
const segment = (id: string, seconds: number, callId = "call-a"): EvidenceSegment => ({
  id, callId, speaker: "caller", content: "Confirmo el precio", recordedAt: at(seconds), contentDeletedAt: null,
});
const event = (id: string, seconds: number): EvidenceEvent => ({
  id, callId: "call-a", type: "quote.received", title: "Quote received", detail: null, occurredAt: at(seconds),
});

async function main() {
  const segments = [segment("older", 0), segment("newer", 20), segment("foreign", 11, "call-b")];
  assert.equal(matchEvidenceEvents([event("nearest", 11)], segments)[0].match?.segmentId, "newer");
  assert.equal(matchEvidenceEvents([event("tie", 10)], segments)[0].match?.segmentId, "older");
  assert.equal(matchEvidenceEvents([event("boundary", 50)], segments)[0].match?.segmentId, "newer");
  assert.equal(matchEvidenceEvents([event("too-far", 51)], segments)[0].match, null);
  assert.equal(matchEvidenceEvents([{ ...event("operation", 20), callId: null }], segments)[0].match, null);
  assert.equal(matchEvidenceEvents([event("foreign", 10)], [segment("other", 10, "call-b")])[0].match, null);
  const redacted = { ...segment("deleted", 10), content: null, contentDeletedAt: at(500) };
  assert.equal(matchEvidenceEvents([event("metadata", 10)], [redacted])[0].match?.segmentId, "deleted");

  const requests: URL[] = [];
  const transcript = Array.from({ length: 1001 }, (_, i) => ({ id: `segment-${i}`, speaker: "caller",
    content: i === 1000 ? null : "Fixture transcript", recorded_at: at(i), content_deleted_at: i === 1000 ? at(1500) : null }));
  let noCalls = false;
  const client = createClient("https://fixture.example.com", "fixture", {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      requests.push(url);
      const table = url.pathname.split("/").at(-1);
      let data: unknown;
      if (table === "operations") { assert.equal(url.searchParams.get("reference"), "eq.OP-991001"); data = { id: "op-a", reference: "OP-991001" }; }
      else if (table === "calls") {
        assert.equal(url.searchParams.get("operation_id"), "eq.op-a");
        data = noCalls ? [] : [{ id: "call-a", contact_id: null, provider_id: "provider-a", direction: "outbound", outcome: "completed", started_at: at(0), ended_at: at(1200) }];
      } else if (table === "providers") data = [{ id: "provider-a", name: "Fixture provider" }];
      else if (table === "call_transcript_segments") {
        assert.equal(url.searchParams.get("call_id"), "eq.call-a");
        const start = Number(url.searchParams.get("offset") ?? 0);
        data = transcript.slice(start, start + Number(url.searchParams.get("limit")));
      } else if (table === "events") {
        assert.equal(url.searchParams.get("operation_id"), "eq.op-a");
        if (noCalls) assert.equal(url.searchParams.get("call_id"), "is.null");
        else assert.equal(url.searchParams.get("or"), "(call_id.eq.call-a,call_id.is.null)");
        data = noCalls ? [] : [{ id: "quote-event", call_id: "call-a", type: "quote.received", occurred_at: at(400), payload: {} },
          { id: "selection", call_id: null, type: "quote.selected", occurred_at: at(1400), payload: {} }];
      } else throw new Error(`Unexpected table: ${table}`);
      return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    } },
  });
  const evidence = await getDashboardCallEvidence("OP-991001", undefined, client);
  assert.ok(evidence);
  assert.equal(evidence.segments.length, 1001, "must load the full transcript beyond the default row cap");
  assert.equal(evidence.segments[1000].content, null);
  assert.equal(evidence.events[0].match?.segmentId, "segment-400");
  assert.equal(evidence.events[1].match, null);
  const before = requests.length;
  assert.equal(await getDashboardCallEvidence("OP-991001", "foreign-call", client), null);
  assert.deepEqual(requests.slice(before).map((url) => url.pathname.split("/").at(-1)), ["operations", "calls"]);
  noCalls = true;
  assert.equal((await getDashboardCallEvidence("OP-991001", undefined, client))?.segments.length, 0);
  let status = 0;
  const response = { status(value: number) { status = value; return this; }, json() {} };
  await requireDashboardAuth({ header: () => undefined } as never, response as never, () => assert.fail("Unauthenticated access"));
  assert.equal(status, 401);
  console.log("Evidence passed: full 1001-segment transcript, same-call timestamp matching, bounds, retained metadata, empty state and auth/operation isolation. Mocked API only.");
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
