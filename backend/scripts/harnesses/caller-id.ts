import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { routeIncomingCall } from "../../src/tango/telephony/inbound-routing";

// Keep this harness offline, including the default client created on import.
Object.assign(process.env, {
  SUPABASE_URL: "https://supabase.example.com",
  SUPABASE_SECRET_KEY: "fixture-secret",
  SUPABASE_PUBLISHABLE_KEY: "fixture-public",
  OPENAI_API_KEY: "fixture-key",
  OPENAI_WEBHOOK_SECRET: "fixture-secret",
  TWILIO_ACCOUNT_SID: "fixture-account",
  TWILIO_AUTH_TOKEN: "fixture-token",
  TWILIO_FROM_NUMBER: "+14155550100",
  EMAIL_DELIVERY_MODE: "preview",
});
const { findCounterpartyByCallerId } = require("../../src/tango/supabase/erp") as typeof import("../../src/tango/supabase/erp");

type Row = { id: string; name: string; phone: string; email: null; active: boolean; authorized: boolean };
function row(phone: string, id = "person-a"): Row {
  return { id, name: "Fixture", phone, email: null, active: true, authorized: true };
}

function database(contacts: Row[] = [], providers: Row[] = [], fail = false) {
  return createClient("https://supabase.example.com", "fixture-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        assert.equal(init?.method, "GET", "Caller identification must be read-only");
        if (fail) return new Response(JSON.stringify({ message: "Database unavailable" }), { status: 503 });
        const url = new URL(String(input));
        const table = url.pathname.split("/").at(-1);
        assert.ok(table === "contacts" || table === "providers");
        const filter = url.searchParams.get("phone") ?? "";
        // Emulate PostgREST filtering, leaving maybeSingle cardinality checks
        // to the real Supabase client so duplicate identities fail closed.
        let phones: string[];
        if (filter.startsWith("in.(")) phones = filter.slice(4, -1).split(",");
        else if (filter.startsWith("eq.")) phones = [filter.slice(3)];
        else throw new Error("Missing phone filter");
        const rows = (table === "contacts" ? contacts : providers).filter((entry) => phones.includes(entry.phone));
        return new Response(JSON.stringify(rows), { headers: { "Content-Type": "application/json" } });
      },
    },
  });
}

async function main() {
  const withoutNine = "+541163718087";
  const withNine = "+5491163718087";
  for (const persona of ["client", "provider"] as const) {
    for (const stored of [withoutNine, withNine]) {
      const entry = row(stored);
      const db = persona === "client" ? database([entry]) : database([], [entry]);
      for (const incoming of [withoutNine, withNine]) {
        const identity = await findCounterpartyByCallerId(incoming, db);
        assert.equal(identity?.persona, persona);
        assert.equal(identity?.phone, stored, "Preserve the stored phone");
        const routed = await routeIncomingCall({
          type: "realtime.call.incoming",
          data: { call_id: "rtc_fixture", sip_headers: [
            { name: "From", value: `<sip:${incoming}@pstn.twilio.com>` },
            { name: "X-Twilio-CallSid", value: "CAfixture" },
          ] },
        }, {
          findIdentity: (phone) => findCounterpartyByCallerId(phone, db),
          listClientOperations: async () => [], listProviderOperations: async () => [],
        });
        assert.equal(routed.action, "accept");
        assert.equal(routed.callerPhone, incoming, "Preserve the received caller ID");
      }
    }
  }

  const first = row(withoutNine);
  const second = row(withNine, "person-b");
  for (const db of [database([first, second]), database([], [first, second]), database([first], [second])]) {
    for (const incoming of [withoutNine, withNine]) await assert.rejects(findCounterpartyByCallerId(incoming, db));
  }
  assert.equal(await findCounterpartyByCallerId(withoutNine, database()), null);
  await assert.rejects(findCounterpartyByCallerId(withoutNine, database([], [], true)));
  await assert.rejects(findCounterpartyByCallerId("1163718087", database()), /E.164/);
  assert.equal((await findCounterpartyByCallerId(` ${withoutNine} `, database([], [second])))?.phone, withNine);

  // Other countries and nonstandard Argentine lengths retain exact matching.
  for (const [incoming, other] of [["+14155550100", "+194155550100"], ["+54116371808", "+549116371808"], ["+5411637180870", "+54911637180870"]]) {
    assert.equal(await findCounterpartyByCallerId(incoming, database([], [row(other)])), null);
    assert.equal((await findCounterpartyByCallerId(incoming, database([], [row(incoming)])))?.phone, incoming);
  }
  for (const [persona, reason] of [["client", "inactive_contact"], ["provider", "unknown_caller"], ["unauthorized", "unauthorized_contact"]]) {
    const entry = { ...second, active: persona === "unauthorized", authorized: false };
    const db = persona === "provider" ? database([], [entry]) : database([entry]);
    const routed = await routeIncomingCall({ type: "realtime.call.incoming", data: {
      call_id: "rtc_blocked", sip_headers: [{ name: "From", value: `<sip:${withoutNine}@pstn.twilio.com>` }],
    } }, {
      findIdentity: (phone) => findCounterpartyByCallerId(phone, db),
      listClientOperations: async () => { throw new Error("Unauthorized context read"); },
      listProviderOperations: async () => { throw new Error("Unauthorized context read"); },
    });
    assert.equal(routed.action, "reject");
    if (routed.action === "reject") assert.equal(routed.reason, reason);
  }
  console.log("Caller ID harness passed: Argentine variants, exact foreign matching, ambiguity, authorization and unchanged phones.");
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
