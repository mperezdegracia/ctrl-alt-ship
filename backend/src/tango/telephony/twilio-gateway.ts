export type TwilioGatewayOptions = Readonly<{
  accountSid: string;
  authToken: string;
  fromNumber: string;
  logger?: TwilioGatewayLogger;
  fetch?: typeof fetch;
}>;

export type TwilioGatewayLogger = Readonly<{
  info: (event: string, fields: Record<string, unknown>) => void;
  error: (event: string, fields: Record<string, unknown>) => void;
}>;

export type SupervisorTransfer = Readonly<{
  callSid: string;
  to: string;
}>;

export type ConferenceMove = Readonly<{
  callSid: string;
  conferenceName: string;
}>;

export type SupervisorConferenceCall = Readonly<{
  conferenceName: string;
  to: string;
}>;

/** Small Twilio REST boundary. It deliberately accepts only server-owned values. */
export class TwilioGateway {
  private readonly fetchImplementation: typeof fetch;
  private readonly apiBaseUrl: string;
  private readonly authorization: string;

  constructor(private readonly options: TwilioGatewayOptions) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.apiBaseUrl = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}`;
    this.authorization = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString("base64")}`;
  }

  async transferCallToSupervisor(transfer: SupervisorTransfer): Promise<void> {
    await this.post(`/Calls/${encodeURIComponent(transfer.callSid)}.json`, {
      Twiml: transferTwiml(transfer.to, this.options.fromNumber),
    }, {
      operation: "transfer.dial_supervisor",
      call_sid_suffix: transfer.callSid.slice(-6),
      destination_phone_suffix: transfer.to.slice(-4),
    });
  }

  /**
   * Retained for manual conference experiments. The live `escalate` path uses
   * transferCallToSupervisor and does not invoke either conference method.
   */
  async moveCallToConference(move: ConferenceMove): Promise<void> {
    await this.post(`/Calls/${encodeURIComponent(move.callSid)}.json`, {
      Twiml: conferenceTwiml(move.conferenceName),
    }, {
      operation: "conference.move_caller",
      conference_name: move.conferenceName,
      call_sid_suffix: move.callSid.slice(-6),
    });
  }

  /** See moveCallToConference: available, but not connected to `escalate`. */
  async callSupervisorToConference(supervisor: SupervisorConferenceCall): Promise<void> {
    await this.post("/Calls.json", {
      To: supervisor.to,
      From: this.options.fromNumber,
      Twiml: conferenceTwiml(supervisor.conferenceName),
    }, {
      operation: "conference.dial_supervisor",
      conference_name: supervisor.conferenceName,
      destination_phone_suffix: supervisor.to.slice(-4),
    });
  }

  private async post(path: string, body: Record<string, string>, details: Record<string, unknown>): Promise<void> {
    this.options.logger?.info("twilio.request_started", details);
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.apiBaseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: this.authorization,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(body),
      });
    } catch (error) {
      this.options.logger?.error("twilio.request_failed", { ...details, failure_kind: "network", error });
      throw error;
    }

    if (!response.ok) {
      const twilioErrorCode = await errorCode(response);
      this.options.logger?.error("twilio.request_failed", {
        ...details,
        failure_kind: "http",
        http_status: response.status,
        ...(twilioErrorCode === undefined ? {} : { twilio_error_code: twilioErrorCode }),
      });
      throw new Error(`Twilio ${details.operation} failed with status ${response.status}${twilioErrorCode === undefined ? "" : ` (code ${twilioErrorCode})`}`);
    }

    this.options.logger?.info("twilio.request_succeeded", { ...details, http_status: response.status });
  }
}

async function errorCode(response: Response): Promise<number | undefined> {
  try {
    const payload = await response.json() as { code?: unknown };
    return typeof payload.code === "number" ? payload.code : undefined;
  } catch {
    return undefined;
  }
}

function transferTwiml(destination: string, callerId: string): string {
  return `<Response><Dial callerId="${escapeXml(callerId)}"><Number>${escapeXml(destination)}</Number></Dial></Response>`;
}

function conferenceTwiml(conferenceName: string): string {
  return `<Response><Dial><Conference>${escapeXml(conferenceName)}</Conference></Dial></Response>`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&apos;",
    "\"": "&quot;",
  })[character]!);
}
