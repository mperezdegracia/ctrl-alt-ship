import type { RenderedEmail } from "./email-templates";

export type DeliveryMode = "preview" | "resend";

export type EmailDeliveryRequest = RenderedEmail & {
  to: string;
  idempotencyKey: string;
  operationId: string;
  template: string;
};

export type EmailDeliveryResult = {
  providerMessageId: string;
  preview: boolean;
};

export interface EmailGateway {
  readonly mode: DeliveryMode;
  deliver(message: EmailDeliveryRequest): Promise<EmailDeliveryResult>;
}

export class EmailDeliveryError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(`Email delivery failed: ${code}`);
    this.name = "EmailDeliveryError";
  }
}

/** Stores the rendered message in the local preview table, never sends it. */
export class PreviewEmailGateway implements EmailGateway {
  readonly mode = "preview" as const;

  async deliver(message: EmailDeliveryRequest): Promise<EmailDeliveryResult> {
    return { providerMessageId: `preview:${message.idempotencyKey}`, preview: true };
  }
}

type ResendResponse = { id?: unknown; name?: unknown; message?: unknown };

/** Minimal Resend REST adapter; keeping it behind EmailGateway makes replacement local. */
export class ResendEmailGateway implements EmailGateway {
  readonly mode = "resend" as const;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async deliver(message: EmailDeliveryRequest): Promise<EmailDeliveryResult> {
    const response = await this.fetchImplementation("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": message.idempotencyKey,
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        tags: [
          { name: "operation", value: message.operationId },
          { name: "template", value: message.template },
        ],
      }),
    });

    const body = await this.readBody(response);
    if (!response.ok) {
      const code = this.errorCode(response.status, body);
      throw new EmailDeliveryError(code, this.isRetryable(response.status, body));
    }
    if (typeof body.id !== "string" || body.id.trim() === "") {
      throw new EmailDeliveryError("resend_invalid_response", true);
    }
    return { providerMessageId: body.id, preview: false };
  }

  private async readBody(response: Response): Promise<ResendResponse> {
    try {
      const body = await response.json();
      return body && typeof body === "object" ? body as ResendResponse : {};
    } catch {
      return {};
    }
  }

  private errorCode(status: number, body: ResendResponse): string {
    const candidate = typeof body.name === "string" ? body.name : undefined;
    return candidate && /^[a-z0-9_-]{1,100}$/i.test(candidate)
      ? `resend_${candidate.toLowerCase()}`
      : `resend_http_${status}`;
  }

  private isRetryable(status: number, body: ResendResponse): boolean {
    if (status === 408 || status === 429 || status >= 500) return true;
    // Resend documents this conflict as safe to retry later: another identical
    // idempotent request is still running.
    return status === 409 && body.name === "concurrent_idempotent_requests";
  }
}
