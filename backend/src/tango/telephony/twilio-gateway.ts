export type TwilioGatewayOptions = Readonly<{
  accountSid: string;
  authToken: string;
  fromNumber: string;
  fetch?: typeof fetch;
}>;

export type ConferenceMove = Readonly<{
  callSid: string;
  conferenceName: string;
}>;

export type SupervisorCall = Readonly<{
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

  async moveCallToConference(move: ConferenceMove): Promise<void> {
    await this.post(`/Calls/${encodeURIComponent(move.callSid)}.json`, { Twiml: conferenceTwiml(move.conferenceName) });
  }

  async callSupervisorToConference(supervisor: SupervisorCall): Promise<void> {
    await this.post("/Calls.json", {
      To: supervisor.to,
      From: this.options.fromNumber,
      Twiml: conferenceTwiml(supervisor.conferenceName),
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
