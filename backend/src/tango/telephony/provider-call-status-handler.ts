import type {
  ProviderCallStatus,
  RecordProviderCallStatusResult,
} from "../../domain/provider-contact-contract";
import type { ProviderContactRepository } from "../supabase/provider-contact-repository";
import { verifyTwilioSignature } from "./twilio-outbound";

export class ProviderCallStatusHttpError extends Error {
  constructor(readonly statusCode: 400 | 403 | 500, message: string) {
    super(message);
    this.name = "ProviderCallStatusHttpError";
  }
}

export type ProviderCallStatusRequest = {
  url: string;
  signature: string | undefined;
  accountSid: string | undefined;
  callRecordId: string | undefined;
  body: Record<string, string>;
};

export type ProviderCallStatusHandlerDependencies = {
  repository: ProviderContactRepository;
  expectedAccountSid: string;
  verifySignature?: typeof verifyTwilioSignature;
};

const statuses: readonly ProviderCallStatus[] = [
  "queued", "initiated", "ringing", "in-progress", "completed",
  "busy", "failed", "no-answer", "canceled",
];

function isStatus(value: string): value is ProviderCallStatus {
  return (statuses as readonly string[]).includes(value);
}

function requiredString(value: string | undefined, field: string): string {
  if (!value) throw new ProviderCallStatusHttpError(400, `Missing ${field}`);
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function parseSequence(value: string | undefined): number {
  const sequence = requiredString(value, "SequenceNumber");
  if (!/^[0-9]+$/.test(sequence)) {
    throw new ProviderCallStatusHttpError(400, "Invalid SequenceNumber");
  }
  const parsed = Number(sequence);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new ProviderCallStatusHttpError(400, "Invalid SequenceNumber");
  }
  return parsed;
}

function parseTimestamp(value: string | undefined): string {
  const timestamp = requiredString(value, "Timestamp");
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new ProviderCallStatusHttpError(400, "Invalid Timestamp");
  }
  return new Date(timestamp).toISOString();
}

export class ProviderCallStatusHandler {
  constructor(private readonly dependencies: ProviderCallStatusHandlerDependencies) {}

  async handle(request: ProviderCallStatusRequest): Promise<RecordProviderCallStatusResult> {
    const callRecordId = requiredString(request.callRecordId, "call_record_id");
    if (!isUuid(callRecordId)) throw new ProviderCallStatusHttpError(400, "Invalid call_record_id");
    let callbackUrl: URL;
    try {
      callbackUrl = new URL(request.url);
    } catch {
      throw new ProviderCallStatusHttpError(400, "Invalid callback URL");
    }
    if (callbackUrl.searchParams.getAll("call_record_id").length !== 1
      || callbackUrl.searchParams.get("call_record_id") !== callRecordId) {
      throw new ProviderCallStatusHttpError(400, "Callback correlation mismatch");
    }

    const accountSid = requiredString(request.accountSid, "AccountSid");
    if (accountSid !== this.dependencies.expectedAccountSid) {
      throw new ProviderCallStatusHttpError(403, "Unexpected AccountSid");
    }
    if (request.body.AccountSid !== accountSid) {
      throw new ProviderCallStatusHttpError(403, "AccountSid correlation mismatch");
    }
    const verify = this.dependencies.verifySignature ?? verifyTwilioSignature;
    if (!verify(request.url, request.body, request.signature)) {
      throw new ProviderCallStatusHttpError(403, "Invalid Twilio signature");
    }

    const sid = requiredString(request.body.CallSid, "CallSid");
    if (!/^CA[0-9a-f]{32}$/i.test(sid)) throw new ProviderCallStatusHttpError(400, "Invalid CallSid");
    const rawStatus = requiredString(request.body.CallStatus, "CallStatus");
    const status = rawStatus === "answered" ? "in-progress" : rawStatus;
    if (!isStatus(status)) throw new ProviderCallStatusHttpError(400, "Invalid CallStatus");
    const sequence = parseSequence(request.body.SequenceNumber);
    const eventAt = parseTimestamp(request.body.Timestamp);

    // The RPC owns monotonicity, duplicate handling, and retry scheduling.
    try {
      return await this.dependencies.repository.recordStatus({
        p_call_id: callRecordId,
        p_twilio_call_sid: sid,
        p_status: status,
        p_sequence: sequence,
        p_event_at: eventAt,
      });
    } catch {
      throw new ProviderCallStatusHttpError(500, "Could not persist provider call status");
    }
  }
}
