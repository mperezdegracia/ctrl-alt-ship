import { createHmac, timingSafeEqual } from "node:crypto";

import { environment } from "../../config/environment";

export type OutboundCallRequest = {
  to: string;
  phoneType?: "mobile" | "landline";
  callRecordId: string;
  purpose: "quote_request" | "renegotiation" | "booking_replacement";
};

/** Twilio requires Argentina's international mobile marker, but never for a fixed line. */
export function formatOutboundVoiceDestination(phone: string, phoneType?: "mobile" | "landline"): string {
  if (phoneType !== "mobile" || !phone.startsWith("+54") || phone.startsWith("+549")) return phone;
  return `+549${phone.slice(3)}`;
}

function xml(value: string): string {
  return value.replace(/[<>&'\"]/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;",
  })[character] ?? character);
}

function requiredTwilioConfig() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, PUBLIC_BASE_URL, OPENAI_PROJECT_ID } = environment;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !PUBLIC_BASE_URL || !OPENAI_PROJECT_ID) {
    throw new Error("Outbound Twilio configuration is incomplete");
  }
  return { accountSid: TWILIO_ACCOUNT_SID, authToken: TWILIO_AUTH_TOKEN, from: TWILIO_FROM_NUMBER, baseUrl: PUBLIC_BASE_URL.replace(/\/$/, ""), projectId: OPENAI_PROJECT_ID };
}

export function buildOutboundTwiml(callRecordId: string): string {
  const { baseUrl, projectId } = requiredTwilioConfig();
  const sipUri = `sip:${projectId}@sip.api.openai.com;transport=tls?X-Tango-Call-Id=${encodeURIComponent(callRecordId)}`;
  return `<Response><Dial record="record-from-answer-dual" recordingStatusCallback="${xml(`${baseUrl}/twilio/recording-status`)}" recordingStatusCallbackEvent="completed"><Sip>${xml(sipUri)}</Sip></Dial></Response>`;
}

export async function createTwilioOutboundCall(request: OutboundCallRequest): Promise<{ sid: string }> {
  const config = requiredTwilioConfig();
  const statusCallback = new URL(`${config.baseUrl}/twilio/call-status`);
  statusCallback.searchParams.set("call_record_id", request.callRecordId);
  const body = new URLSearchParams({
    To: formatOutboundVoiceDestination(request.to, request.phoneType), From: config.from, Twiml: buildOutboundTwiml(request.callRecordId),
  });
  body.append("StatusCallback", statusCallback.toString());
  body.append("StatusCallbackEvent", "initiated");
  body.append("StatusCallbackEvent", "ringing");
  body.append("StatusCallbackEvent", "answered");
  body.append("StatusCallbackEvent", "completed");
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Calls.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json() as { sid?: string; message?: string };
  if (!response.ok || !payload.sid) throw new Error(`Twilio outbound call failed: ${payload.message ?? response.status}`);
  return { sid: payload.sid };
}

export function verifyTwilioSignature(url: string, params: Record<string, string>, signature: string | undefined): boolean {
  const token = environment.TWILIO_AUTH_TOKEN;
  if (!token || !signature) return false;
  const data = url + Object.keys(params).sort().map((key) => `${key}${params[key]}`).join("");
  const expected = createHmac("sha1", token).update(data).digest("base64");
  const actual = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}
