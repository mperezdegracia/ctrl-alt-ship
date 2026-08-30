import assert from "node:assert/strict";
import { resolve } from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: resolve(__dirname, "../../.env") });

type Mode = "transfer" | "conference";
type TwilioCall = Readonly<{ sid: string; status: string }>;

const argumentsByName = new Map(
  process.argv.slice(2).map((argument) => {
    const [name, value = ""] = argument.split("=", 2);
    return [name, value];
  }),
);
const mode = argumentsByName.get("--mode") as Mode | undefined;
const caller = argumentsByName.get("--caller");
const supervisor = argumentsByName.get("--supervisor");
const execute = argumentsByName.has("--execute");
const waitSeconds = Number(argumentsByName.get("--wait-seconds") ?? "30");

function requireValue(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in backend/.env`);
  return value;
}

function assertPhone(name: string, value: string | undefined): asserts value is string {
  assert.match(value ?? "", /^\+[1-9]\d{7,14}$/, `${name} must be an E.164 phone number.`);
}

function xml(value: string): string {
  return value.replace(/[<>&'"]/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;",
  })[character] ?? character);
}

async function main(): Promise<void> {
  assert.ok(mode === "transfer" || mode === "conference", "Use --mode=transfer or --mode=conference.");
  assertPhone("--caller", caller);
  assertPhone("--supervisor", supervisor);
  assert.notEqual(caller, supervisor, "Caller and supervisor must be distinct test phones.");
  assert.ok(Number.isInteger(waitSeconds) && waitSeconds >= 5 && waitSeconds <= 60, "--wait-seconds must be an integer from 5 to 60.");

  const plan = {
    mode,
    caller_suffix: caller.slice(-4),
    supervisor_suffix: supervisor.slice(-4),
    wait_seconds: waitSeconds,
  };
  console.log(JSON.stringify({ event: "twilio_handoff_smoke.planned", ...plan }));
  if (!execute) {
    console.log("Dry run. Add --execute to place the test call.");
    return;
  }

  const accountSid = requireValue("TWILIO_ACCOUNT_SID");
  const authToken = requireValue("TWILIO_AUTH_TOKEN");
  const from = requireValue("TWILIO_FROM_NUMBER");
  const client = new TwilioRestClient(accountSid, authToken);

  const parent = await client.createCall({
    to: caller,
    from,
    twiml: "<Response><Pause length=\"60\" /></Response>",
  });
  console.log(JSON.stringify({ event: "twilio_handoff_smoke.caller_dialed", parent_call_sid: parent.sid, status: parent.status }));

  await waitForAnswer(client, parent.sid, waitSeconds);
  if (mode === "transfer") {
    await client.updateCall(parent.sid, `<Response><Dial callerId="${xml(from)}"><Number>${xml(supervisor)}</Number></Dial></Response>`);
    console.log(JSON.stringify({ event: "twilio_handoff_smoke.transfer_requested", parent_call_sid: parent.sid }));
    return;
  }

  const conferenceName = `local-smoke-${parent.sid}`;
  const conferenceTwiml = `<Response><Dial><Conference>${xml(conferenceName)}</Conference></Dial></Response>`;
  await client.updateCall(parent.sid, conferenceTwiml);
  const child = await client.createCall({ to: supervisor, from, twiml: conferenceTwiml });
  console.log(JSON.stringify({
    event: "twilio_handoff_smoke.conference_requested",
    parent_call_sid: parent.sid,
    supervisor_call_sid: child.sid,
    conference_name: conferenceName,
  }));
}

async function waitForAnswer(client: TwilioRestClient, callSid: string, timeoutSeconds: number): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    const call = await client.getCall(callSid);
    if (call.status === "in-progress") return;
    if (["busy", "canceled", "completed", "failed", "no-answer"].includes(call.status)) {
      throw new Error(`Caller leg ended before transfer: ${call.status}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`Caller did not answer within ${timeoutSeconds} seconds.`);
}

class TwilioRestClient {
  private readonly baseUrl: string;
  private readonly authorization: string;

  constructor(accountSid: string, authToken: string) {
    this.baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`;
    this.authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
  }

  async createCall(input: { to: string; from: string; twiml: string }): Promise<TwilioCall> {
    return this.request("/Calls.json", "POST", { To: input.to, From: input.from, Twiml: input.twiml });
  }

  async updateCall(callSid: string, twiml: string): Promise<TwilioCall> {
    return this.request(`/Calls/${encodeURIComponent(callSid)}.json`, "POST", { Twiml: twiml });
  }

  async getCall(callSid: string): Promise<TwilioCall> {
    return this.request(`/Calls/${encodeURIComponent(callSid)}.json`, "GET");
  }

  private async request(path: string, method: "GET" | "POST", body?: Record<string, string>): Promise<TwilioCall> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: this.authorization, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(body ? { body: new URLSearchParams(body) } : {}),
    });
    const payload = await response.json() as { sid?: unknown; status?: unknown; code?: unknown; message?: unknown };
    if (!response.ok || typeof payload.sid !== "string" || typeof payload.status !== "string") {
      const code = typeof payload.code === "number" ? ` (code ${payload.code})` : "";
      throw new Error(`Twilio ${method} ${path} failed with status ${response.status}${code}`);
    }
    return { sid: payload.sid, status: payload.status };
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
