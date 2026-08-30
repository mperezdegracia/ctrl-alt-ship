export type RecordingStatus = "in-progress" | "completed" | "absent" | "failed";

export type RecordingStatusRequest = {
  url: string;
  signature: string | undefined;
  body: unknown;
};

export type RecordingStatusResult = { persisted: true; expired: boolean };

export type RecordingStatusPersistence = {
  recordStatus(params: {
    p_twilio_call_sid: string;
    p_recording_sid: string | null;
    p_status: RecordingStatus;
  }): Promise<RecordingStatusResult>;
};

export type RecordingStatusHandlerDependencies = {
  repository: RecordingStatusPersistence;
  expectedAccountSid: string;
  verifySignature: (url: string, body: Record<string, string>, signature: string | undefined) => boolean;
};

export class RecordingStatusHttpError extends Error {
  constructor(readonly statusCode: 400 | 403 | 500, message: string) {
    super(message);
    this.name = "RecordingStatusHttpError";
  }
}

const statuses: readonly RecordingStatus[] = ["in-progress", "completed", "absent", "failed"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RecordingStatusHttpError(400, `Missing or invalid ${field}`);
  }
  return value;
}

function isCallSid(value: string): boolean {
  return /^CA[0-9a-f]{32}$/i.test(value);
}

function isRecordingSid(value: string): boolean {
  return /^RE[0-9a-f]{32}$/i.test(value);
}

function isAccountSid(value: string): boolean {
  return /^AC[0-9a-f]{32}$/i.test(value);
}

function isRecordingStatus(value: string): value is RecordingStatus {
  return (statuses as readonly string[]).includes(value);
}

function parseBody(value: unknown): Record<string, string> {
  if (!isRecord(value) || Object.values(value).some((field) => typeof field !== "string")) {
    throw new RecordingStatusHttpError(400, "Invalid recording callback body");
  }
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, String(field)]));
}

export class RecordingStatusHandler {
  constructor(private readonly dependencies: RecordingStatusHandlerDependencies) {}

  async handle(request: RecordingStatusRequest): Promise<RecordingStatusResult> {
    const url = requiredString(request.url, "callback URL");
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("unsupported protocol");
    } catch {
      throw new RecordingStatusHttpError(400, "Invalid callback URL");
    }
    const body = parseBody(request.body);
    const accountSid = requiredString(body.AccountSid, "AccountSid");
    if (!isAccountSid(accountSid) || accountSid !== this.dependencies.expectedAccountSid) {
      throw new RecordingStatusHttpError(403, "Unexpected AccountSid");
    }
    if (!this.dependencies.verifySignature(url, body, request.signature)) {
      throw new RecordingStatusHttpError(403, "Invalid Twilio signature");
    }

    const callSid = requiredString(body.CallSid, "CallSid");
    if (!isCallSid(callSid)) throw new RecordingStatusHttpError(400, "Invalid CallSid");
    const statusValue = requiredString(body.RecordingStatus, "RecordingStatus");
    if (!isRecordingStatus(statusValue)) throw new RecordingStatusHttpError(400, "Invalid RecordingStatus");
    const recordingSidValue = body.RecordingSid;
    const recordingSid = recordingSidValue === undefined || recordingSidValue === "" ? null : recordingSidValue;
    if ((statusValue === "completed" || statusValue === "in-progress") && recordingSid === null) {
      throw new RecordingStatusHttpError(400, "RecordingSid is required for this status");
    }
    if (recordingSid !== null && !isRecordingSid(recordingSid)) {
      throw new RecordingStatusHttpError(400, "Invalid RecordingSid");
    }

    try {
      const result = await this.dependencies.repository.recordStatus({
        p_twilio_call_sid: callSid,
        p_recording_sid: recordingSid,
        p_status: statusValue,
      });
      if (result?.persisted !== true || typeof result.expired !== "boolean") throw new Error("Invalid recording persistence result");
      return result;
    } catch {
      throw new RecordingStatusHttpError(500, "Could not persist recording status");
    }
  }
}
