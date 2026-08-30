import assert from "node:assert/strict";

import {
  EmailDeliveryError,
  PreviewEmailGateway,
  SmtpEmailGateway,
  type EmailGateway,
} from "../../src/tango/services/email-gateway";
import { renderBookingEmail, type BookingEmailPayload } from "../../src/tango/services/email-templates";
import {
  EmailOutboxWorker,
  type EmailOutboxJob,
  type EmailOutboxRepository,
} from "../../src/tango/workers/email-outbox-worker";

const payload: BookingEmailPayload = {
  template: "booking_confirmation_client",
  recipient_type: "client",
  recipient_name: "Lucas <script>",
  recipient_email: "lucas@example.com",
  operation_reference: "OP-900001",
  booking_id: "e1ebfc8d-bfdc-4bd7-afdb-3a9d028b55bf",
  booking: {
    confirmed_price: 900_000,
    currency: "ARS",
    pickup_window_start: "2026-09-01T08:00:00-03:00",
    pickup_window_end: "2026-09-01T12:00:00-03:00",
    payment_term_days: 30,
    confirmation_reference: "CONF-900001",
    container_type: "40_dry",
    gross_weight_kg: 24_000,
    pickup_location: "Terminal 4",
    delivery_location: "Gonzalez Catan",
    client_name: "Lucas",
    provider_name: "Transporte Sur",
  },
};

function job(id: string, overrides: Partial<EmailOutboxJob> = {}): EmailOutboxJob {
  return {
    id,
    operation_id: "8a496762-dca5-46fa-b2f5-45d49e47df80",
    payload,
    idempotency_key: `booking-confirmation:${id}:client`,
    attempts: 1,
    lock_token: "c8bdf48b-36cd-4545-bf0d-10c8d58454cc",
    ...overrides,
  };
}

class MemoryRepository implements EmailOutboxRepository {
  readonly completed: Array<{ job: EmailOutboxJob; providerMessageId: string }> = [];
  readonly failed: Array<{ job: EmailOutboxJob; code: string; retryable: boolean }> = [];
  readonly previews: Array<{ job: EmailOutboxJob; subject: string; html: string }> = [];

  constructor(private readonly batches: EmailOutboxJob[][]) {}

  async claim(): Promise<EmailOutboxJob[]> {
    return this.batches.shift() ?? [];
  }

  async savePreview(jobValue: EmailOutboxJob, message: { subject: string; text: string; html: string }): Promise<void> {
    this.previews.push({ job: jobValue, subject: message.subject, html: message.html });
  }

  async complete(jobValue: EmailOutboxJob, providerMessageId: string): Promise<void> {
    this.completed.push({ job: jobValue, providerMessageId });
  }

  async fail(jobValue: EmailOutboxJob, code: string, retryable: boolean): Promise<void> {
    this.failed.push({ job: jobValue, code, retryable });
  }
}

const silentLogger = { info() {}, warn() {}, error() {} };

async function main(): Promise<void> {
  const previewRepository = new MemoryRepository([[job("preview-job")]]);
  const previewWorker = new EmailOutboxWorker(previewRepository, new PreviewEmailGateway(), silentLogger);
  assert.equal(await previewWorker.runOnce(), 1);
  assert.equal(previewRepository.completed.length, 1);
  assert.equal(previewRepository.completed[0]?.providerMessageId, "preview:booking-confirmation:preview-job:client");
  assert.equal(previewRepository.previews.length, 1);
  assert.match(previewRepository.previews[0]?.html ?? "", /Lucas &lt;script&gt;/);

  const missingRecipientRepository = new MemoryRepository([[job("invalid-recipient", {
    payload: { ...payload, recipient_email: null },
  })]]);
  const missingRecipientWorker = new EmailOutboxWorker(missingRecipientRepository, new PreviewEmailGateway(), silentLogger);
  await missingRecipientWorker.runOnce();
  assert.deepEqual(missingRecipientRepository.failed.map((failure) => [failure.code, failure.retryable]), [
    ["recipient_email_missing_or_invalid", false],
  ]);

  const retryingGateway: EmailGateway = {
    mode: "smtp",
    async deliver() { throw new EmailDeliveryError("smtp_esocket", true); },
  };
  const retryRepository = new MemoryRepository([[job("retry-job")]]);
  const retryWorker = new EmailOutboxWorker(retryRepository, retryingGateway, silentLogger);
  await retryWorker.runOnce();
  assert.deepEqual(retryRepository.failed.map((failure) => [failure.code, failure.retryable]), [
    ["smtp_esocket", true],
  ]);

  let smtpMessage: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    headers: Record<string, string>;
  } | undefined;
  const smtpGateway = new SmtpEmailGateway(
    {
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      username: "tango.demo@gmail.com",
      password: "app-password",
    },
    "Tango Logistics <notifications@example.com>",
    {
      async sendMail(message) {
        smtpMessage = message;
        return { messageId: "<provider-message-id@gmail.com>" };
      },
    },
  );
  const rendered = renderBookingEmail(payload);
  const smtpResult = await smtpGateway.deliver({
    ...rendered,
    to: payload.recipient_email!,
    idempotencyKey: "booking-confirmation:smtp-job:client",
    operationId: "8a496762-dca5-46fa-b2f5-45d49e47df80",
    template: payload.template,
  });
  assert.equal(smtpResult.providerMessageId, "<provider-message-id@gmail.com>");
  assert.deepEqual(smtpMessage, {
    from: "Tango Logistics <notifications@example.com>",
    to: "lucas@example.com",
    subject: "Booking confirmed — OP-900001",
    html: rendered.html,
    text: rendered.text,
    headers: { "X-Tango-Idempotency-Key": "booking-confirmation:smtp-job:client" },
  });

  console.log("Email outbox harness OK: preview rendering, invalid recipients, retryable failures and Gmail SMTP delivery.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
