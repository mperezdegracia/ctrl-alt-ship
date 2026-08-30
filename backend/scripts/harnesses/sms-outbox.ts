import assert from "node:assert/strict";

import {
  PreviewSmsGateway,
  SmsDeliveryError,
  TwilioSmsGateway,
  type SmsDeliveryRequest,
  type SmsGateway,
} from "../../src/tango/services/sms-gateway";
import { prepareBookingSmsPayload, renderBookingSms } from "../../src/tango/services/sms-templates";
import {
  SmsOutboxWorker,
  type SmsOutboxJob,
  type SmsOutboxRepository,
} from "../../src/tango/workers/sms-outbox-worker";

const payload = {
  template: "booking_confirmation_provider",
  recipient_type: "provider",
  recipient_name: "Transportes del Sur",
  recipient_phone: "+541132555829",
  recipient_phone_type: "mobile",
  operation_reference: "OP-900001",
  booking_id: "e1ebfc8d-bfd7-afdb-3a9d028b55bf",
  booking: {
    confirmed_price: 900_000,
    currency: "ARS",
    pickup_window_start: "2026-09-01 08:00 ART",
    pickup_window_end: "2026-09-01 12:00 ART",
    payment_term_days: 30,
    confirmation_reference: "CONF-900001",
    container_type: "40_dry",
    gross_weight_kg: 24_000,
    pickup_location: "Terminal 4",
    delivery_location: "Gonzalez Catan",
    client_name: "Lucas",
    provider_name: "Transportes del Sur",
  },
};

function job(id: string, overrides: Partial<SmsOutboxJob> = {}): SmsOutboxJob {
  return {
    id,
    operation_id: "8a496762-dca5-46fa-b2f5-45d49e47df80",
    payload,
    idempotency_key: `booking-confirmation-sms:${id}:provider`,
    attempts: 1,
    lock_token: "c8bdf48b-36cd-4545-bf0d-10c8d58454cc",
    ...overrides,
  };
}

class MemoryRepository implements SmsOutboxRepository {
  readonly completed: Array<{ job: SmsOutboxJob; providerMessageId: string }> = [];
  readonly failed: Array<{ job: SmsOutboxJob; code: string; retryable: boolean }> = [];

  constructor(private readonly batches: SmsOutboxJob[][]) {}

  async claim(): Promise<SmsOutboxJob[]> {
    return this.batches.shift() ?? [];
  }

  async complete(jobValue: SmsOutboxJob, providerMessageId: string): Promise<void> {
    this.completed.push({ job: jobValue, providerMessageId });
  }

  async fail(jobValue: SmsOutboxJob, code: string, retryable: boolean): Promise<void> {
    this.failed.push({ job: jobValue, code, retryable });
  }
}

const silentLogger = { info() {}, warn() {}, error() {} };

async function main(): Promise<void> {
  const renderedProvider = renderBookingSms(prepareBookingSmsPayload(payload));
  for (const detail of [
    "Client: Lucas",
    "Route: Terminal 4 -> Gonzalez Catan",
    "Pickup: 2026-09-01 08:00 ART to 2026-09-01 12:00 ART",
    "Cargo: 40_dry, 24000 kg",
    "Confirmed price: ARS 900000.00",
    "Payment term: 30 days from invoice.",
    "Confirmation: CONF-900001",
    "Use these terms for dispatch.",
  ]) assert.match(renderedProvider.body, new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(renderedProvider.body.length <= 459);
  assert.match(renderedProvider.body, /\nRoute: /);

  const renderedClient = renderBookingSms(prepareBookingSmsPayload({
    ...payload,
    template: "booking_confirmation_client",
    recipient_type: "client",
  }));
  assert.match(renderedClient.body, /Provider: Transportes del Sur/);
  assert.match(renderedClient.body, /Keep this confirmation for your records\./);

  let twilioMessage: { to: string; from: string; body: string } | undefined;
  const twilioGateway = new TwilioSmsGateway(
    { accountSid: "AC123", authToken: "token", from: "+14155550100" },
    {
      async sendMessage(message) {
        twilioMessage = message;
        return { sid: "SM123" };
      },
    },
  );
  const result = await twilioGateway.deliver({
    to: payload.recipient_phone,
    phoneType: "mobile",
    body: renderedProvider.body,
    idempotencyKey: "sms-job",
    operationId: "operation",
    template: payload.template,
  });
  assert.deepEqual(result, { providerMessageId: "SM123", preview: false });
  assert.equal(twilioMessage?.to, "+5491132555829");
  assert.equal(twilioMessage?.from, "+14155550100");
  assert.equal(twilioMessage?.body, renderedProvider.body);
  await assert.rejects(
    () => twilioGateway.deliver({
      to: "+541143210000",
      phoneType: "landline",
      body: "Booking confirmed",
      idempotencyKey: "landline",
      operationId: "operation",
      template: payload.template,
    }),
    (error: unknown) => error instanceof SmsDeliveryError
      && error.code === "sms_destination_not_mobile" && !error.retryable,
  );

  const previewRepository = new MemoryRepository([[job("preview-job")]]);
  await new SmsOutboxWorker(previewRepository, new PreviewSmsGateway(), silentLogger).runOnce();
  assert.deepEqual(previewRepository.failed, []);
  assert.equal(previewRepository.completed[0]?.providerMessageId, "preview:booking-confirmation-sms:preview-job:provider");

  const retryRepository = new MemoryRepository([[job("retry-job")]]);
  const retryingGateway: SmsGateway = {
    mode: "twilio",
    async deliver() { throw new SmsDeliveryError("sms_delivery_unavailable", true); },
  };
  await new SmsOutboxWorker(retryRepository, retryingGateway, silentLogger).runOnce();
  assert.deepEqual(retryRepository.failed.map((failure) => [failure.code, failure.retryable]), [
    ["sms_delivery_unavailable", true],
  ]);

  for (const optionalPaymentTerm of [null, undefined, "", "unknown", 0, 30]) {
    const booking: Record<string, unknown> = { ...payload.booking, payment_term_days: optionalPaymentTerm };
    if (optionalPaymentTerm === undefined) delete booking.payment_term_days;
    const body = renderBookingSms(prepareBookingSmsPayload({ ...payload, booking })).body;
    assert.doesNotMatch(body, /undefined|null|NaN/);
    if (optionalPaymentTerm === null || optionalPaymentTerm === undefined || optionalPaymentTerm === "") {
      assert.doesNotMatch(body, /Payment term:/);
    }
  }

  const delivered: SmsDeliveryRequest[] = [];
  const informationRepository = new MemoryRepository([[job("information-job")]]);
  const informationGateway: SmsGateway = {
    mode: "twilio",
    async deliver(message) {
      delivered.push(message);
      return { providerMessageId: "SM-information", preview: false };
    },
  };
  await new SmsOutboxWorker(informationRepository, informationGateway, silentLogger).runOnce();
  assert.equal(delivered.length, 1);
  assert.match(delivered[0]!.body, /Use these terms for dispatch\./);

  console.log("SMS outbox harness OK: complete provider context, Argentina mobile formatting, durable completion and failure handling.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
