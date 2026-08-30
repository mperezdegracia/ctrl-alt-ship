export type DeliveryMode = "preview" | "twilio";

export type SmsDeliveryRequest = {
  to: string;
  phoneType: "mobile" | "landline" | null;
  body: string;
  idempotencyKey: string;
  operationId: string;
  template: string;
};

export type SmsDeliveryResult = {
  providerMessageId: string;
  preview: boolean;
};

export interface SmsGateway {
  readonly mode: DeliveryMode;
  deliver(message: SmsDeliveryRequest): Promise<SmsDeliveryResult>;
}

export class SmsDeliveryError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(`SMS delivery failed: ${code}`);
    this.name = "SmsDeliveryError";
  }
}

type TwilioMessageRequest = { to: string; from: string; body: string };
type TwilioTransport = { sendMessage(message: TwilioMessageRequest): Promise<{ sid?: string }> };

/** Twilio requires Argentina's mobile marker for an outbound mobile destination. */
export function formatOutboundSmsDestination(phone: string, phoneType: "mobile" | "landline" | null): string {
  if (phoneType === "landline") throw new SmsDeliveryError("sms_destination_not_mobile", false);
  if (phone.startsWith("+549")) return phone;
  if (phoneType === "mobile" && phone.startsWith("+54")) return `+549${phone.slice(3)}`;
  return phone;
}

/** Local-safe gateway: accepts work without contacting a recipient. */
export class PreviewSmsGateway implements SmsGateway {
  readonly mode = "preview" as const;

  async deliver(message: SmsDeliveryRequest): Promise<SmsDeliveryResult> {
    return { providerMessageId: `preview:${message.idempotencyKey}`, preview: true };
  }
}

/** Twilio Programmable Messaging adapter, using the existing account credentials. */
export class TwilioSmsGateway implements SmsGateway {
  readonly mode = "twilio" as const;
  private readonly transport: TwilioTransport;

  constructor(
    private readonly config: { accountSid: string; authToken: string; from: string },
    transport?: TwilioTransport,
  ) {
    this.transport = transport ?? { sendMessage: (message) => this.sendWithTwilio(message) };
  }

  async deliver(message: SmsDeliveryRequest): Promise<SmsDeliveryResult> {
    const body = message.body.trim();
    if (!body) throw new SmsDeliveryError("sms_empty_body", false);
    try {
      const result = await this.transport.sendMessage({
        to: formatOutboundSmsDestination(message.to, message.phoneType),
        from: this.config.from,
        body,
      });
      if (typeof result.sid !== "string" || result.sid.trim() === "") {
        throw new SmsDeliveryError("sms_invalid_response", true);
      }
      return { providerMessageId: result.sid, preview: false };
    } catch (error) {
      if (error instanceof SmsDeliveryError) throw error;
      throw this.deliveryError(error);
    }
  }

  private async sendWithTwilio(message: TwilioMessageRequest): Promise<{ sid?: string }> {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: message.to, From: message.from, Body: message.body }),
      },
    );
    const payload = await response.json().catch(() => null) as { sid?: unknown; code?: unknown; message?: unknown } | null;
    if (!response.ok) {
      throw {
        status: response.status,
        code: payload?.code,
        message: payload?.message,
      };
    }
    return { sid: typeof payload?.sid === "string" ? payload.sid : undefined };
  }

  private deliveryError(error: unknown): SmsDeliveryError {
    const details = error && typeof error === "object" ? error as { status?: unknown; code?: unknown } : {};
    const status = typeof details.status === "number" ? details.status : undefined;
    const providerCode = typeof details.code === "number" || typeof details.code === "string" ? String(details.code) : null;
    const code = providerCode && /^[A-Z0-9_-]{1,100}$/i.test(providerCode)
      ? `sms_twilio_${providerCode.toLowerCase()}`
      : status ? `sms_response_${status}` : "sms_delivery_unavailable";
    return new SmsDeliveryError(code, status === undefined || status === 408 || status === 429 || status >= 500);
  }
}
