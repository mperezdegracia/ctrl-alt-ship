export type TwilioGatewayOptions = Readonly<{
  accountSid: string;
  authToken: string;
  fromNumber: string;
  publicBaseUrl: string;
  fetch?: typeof fetch;
}>;

export type SupervisorSummary = Readonly<{
  to: string;
  body: string;
}>;

export type ConferenceMove = Readonly<{
  callSid: string;
  conferenceName: string;
  statusCallbackUrl: string;
  recordingStatusCallbackUrl: string;
}>;

export type SupervisorParticipant = Readonly<{
  conferenceName: string;
  to: string;
  statusCallbackUrl: string;
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

  async sendSupervisorSummary(summary: SupervisorSummary): Promise<void> {
    await this.post("/Messages.json", {
      To: summary.to,
      From: this.options.fromNumber,
      Body: summary.body,
    });
  }

  async moveCallToConference(move: ConferenceMove): Promise<void> {
    const conferenceName = escapeXml(move.conferenceName);
    const statusCallbackUrl = escapeXml(move.statusCallbackUrl);
    const recordingStatusCallbackUrl = escapeXml(move.recordingStatusCallbackUrl);
    const twiml = `<Response><Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="false" beep="false" record="record-from-start" statusCallback="${statusCallbackUrl}" statusCallbackEvent="start end join leave" recordingStatusCallback="${recordingStatusCallbackUrl}">${conferenceName}</Conference></Dial></Response>`;

    await this.post(`/Calls/${encodeURIComponent(move.callSid)}.json`, { Twiml: twiml });
  }

  async addSupervisor(participant: SupervisorParticipant): Promise<void> {
    await this.post(`/Conferences/${encodeURIComponent(participant.conferenceName)}/Participants.json`, {
      To: participant.to,
      From: this.options.fromNumber,
      StartConferenceOnEnter: "false",
      EndConferenceOnExit: "true",
      Beep: "false",
      Label: "supervisor",
      StatusCallback: participant.statusCallbackUrl,
      StatusCallbackEvent: "initiated ringing answered completed",
    });
  }

  private async post(path: string, body: Record<string, string>): Promise<void> {
    const response = await this.fetchImplementation(`${this.apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: this.authorization,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body),
    });
    if (!response.ok) throw new Error(`Twilio request failed with status ${response.status}`);
  }
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
