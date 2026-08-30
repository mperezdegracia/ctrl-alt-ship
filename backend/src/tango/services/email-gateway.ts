import nodemailer from "nodemailer";

import type { RenderedEmail } from "./email-templates";

export type DeliveryMode = "preview" | "smtp";

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

type SmtpTransport = {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    headers: Record<string, string>;
  }): Promise<{ messageId?: string }>;
};

/** SMTP adapter; Gmail works with smtp.gmail.com and an app password. */
export class SmtpEmailGateway implements EmailGateway {
  readonly mode = "smtp" as const;
  private readonly transport: SmtpTransport;

  constructor(
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      username: string;
      password: string;
    },
    private readonly from: string,
    transport?: SmtpTransport,
  ) {
    this.transport = transport ?? nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.username, pass: smtp.password },
    });
  }

  async deliver(message: EmailDeliveryRequest): Promise<EmailDeliveryResult> {
    try {
      const result = await this.transport.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        // SMTP has no standard idempotency header. Keep the durable key in the
        // message for diagnosis while the outbox remains the local authority.
        headers: { "X-Tango-Idempotency-Key": message.idempotencyKey },
      });
      if (typeof result.messageId !== "string" || result.messageId.trim() === "") {
        throw new EmailDeliveryError("smtp_invalid_response", true);
      }
      return { providerMessageId: result.messageId, preview: false };
    } catch (error) {
      if (error instanceof EmailDeliveryError) throw error;
      throw this.deliveryError(error);
    }
  }

  private deliveryError(error: unknown): EmailDeliveryError {
    const details = error && typeof error === "object" ? error as {
      code?: unknown;
      responseCode?: unknown;
    } : {};
    const code = typeof details.code === "string" && /^[A-Z0-9_-]{1,100}$/i.test(details.code)
      ? `smtp_${details.code.toLowerCase()}`
      : typeof details.responseCode === "number"
        ? `smtp_response_${details.responseCode}`
        : "smtp_delivery_failed";
    const retryable = typeof details.responseCode === "number"
      ? details.responseCode >= 400 && details.responseCode < 500
      : true;
    return new EmailDeliveryError(code, retryable);
  }
}
