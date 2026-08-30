export const emailTemplates = [
  "booking_confirmation_client",
  "booking_confirmation_provider",
] as const;

export type EmailTemplate = (typeof emailTemplates)[number];
export type EmailRecipientType = "client" | "provider";

export type BookingEmailPayload = {
  template: EmailTemplate;
  recipient_type: EmailRecipientType;
  recipient_name: string | null;
  recipient_email: string | null;
  operation_reference: string;
  booking_id: string;
  booking: {
    confirmed_price: number | string;
    currency: string;
    pickup_window_start: string;
    pickup_window_end: string;
    payment_term_days: number;
    confirmation_reference: string | null;
    container_type: string;
    gross_weight_kg: number | string;
    pickup_location: string;
    delivery_location: string;
    client_name: string;
    provider_name: string;
  };
};

export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EmailPayloadError(`invalid_${name}`);
  }
  return value;
}

function asNullableText(value: unknown, name: string): string | null {
  if (value === null) return null;
  return asText(value, name);
}

function asPositiveNumber(value: unknown, name: string): number | string {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) > 0) return value;
  throw new EmailPayloadError(`invalid_${name}`);
}

function asNonnegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new EmailPayloadError(`invalid_${name}`);
  }
  return value;
}

export class EmailPayloadError extends Error {
  constructor(readonly code: string) {
    super(`Invalid email outbox payload: ${code}`);
    this.name = "EmailPayloadError";
  }
}

export function parseBookingEmailPayload(value: unknown): BookingEmailPayload {
  if (!isRecord(value) || !isRecord(value.booking)) throw new EmailPayloadError("invalid_payload");
  if (!emailTemplates.includes(value.template as EmailTemplate)) throw new EmailPayloadError("invalid_template");
  if (value.recipient_type !== "client" && value.recipient_type !== "provider") {
    throw new EmailPayloadError("invalid_recipient_type");
  }

  const booking = value.booking;
  return {
    template: value.template as EmailTemplate,
    recipient_type: value.recipient_type,
    recipient_name: asNullableText(value.recipient_name, "recipient_name"),
    recipient_email: asNullableText(value.recipient_email, "recipient_email"),
    operation_reference: asText(value.operation_reference, "operation_reference"),
    booking_id: asText(value.booking_id, "booking_id"),
    booking: {
      confirmed_price: asPositiveNumber(booking.confirmed_price, "confirmed_price"),
      currency: asText(booking.currency, "currency"),
      pickup_window_start: asText(booking.pickup_window_start, "pickup_window_start"),
      pickup_window_end: asText(booking.pickup_window_end, "pickup_window_end"),
      payment_term_days: asNonnegativeInteger(booking.payment_term_days, "payment_term_days"),
      confirmation_reference: asNullableText(booking.confirmation_reference, "confirmation_reference"),
      container_type: asText(booking.container_type, "container_type"),
      gross_weight_kg: asPositiveNumber(booking.gross_weight_kg, "gross_weight_kg"),
      pickup_location: asText(booking.pickup_location, "pickup_location"),
      delivery_location: asText(booking.delivery_location, "delivery_location"),
      client_name: asText(booking.client_name, "client_name"),
      provider_name: asText(booking.provider_name, "provider_name"),
    },
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;",
  })[character] ?? character);
}

function formatMoney(value: number | string, currency: string): string {
  const amount = Number(value);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function bookingDetails(payload: BookingEmailPayload): string[] {
  const booking = payload.booking;
  return [
    `Operation: ${payload.operation_reference}`,
    `Cargo: ${booking.container_type}, ${booking.gross_weight_kg} kg`,
    `Route: ${booking.pickup_location} → ${booking.delivery_location}`,
    `Pickup window: ${booking.pickup_window_start} to ${booking.pickup_window_end}`,
    `Confirmed price: ${formatMoney(booking.confirmed_price, booking.currency)}`,
    `Payment term: ${booking.payment_term_days} days from invoice date`,
    ...(booking.confirmation_reference ? [`Confirmation reference: ${booking.confirmation_reference}`] : []),
  ];
}

function htmlList(items: string[]): string {
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

export function renderBookingEmail(payload: BookingEmailPayload): RenderedEmail {
  const details = bookingDetails(payload);
  const booking = payload.booking;

  if (payload.template === "booking_confirmation_client") {
    const greeting = payload.recipient_name ?? booking.client_name;
    return {
      subject: `Booking confirmed — ${payload.operation_reference}`,
      text: [
        `Hi ${greeting},`,
        "",
        `Your freight booking with ${booking.provider_name} is confirmed.`,
        "",
        ...details,
        "",
        "This is a confirmation of the agreed booking; no reply is required.",
        "",
        "Tango Logistics",
      ].join("\n"),
      html: `<p>Hi ${escapeHtml(greeting)},</p><p>Your freight booking with <strong>${escapeHtml(booking.provider_name)}</strong> is confirmed.</p>${htmlList(details)}<p>This is a confirmation of the agreed booking; no reply is required.</p><p>Tango Logistics</p>`,
    };
  }

  const greeting = payload.recipient_name ?? booking.provider_name;
  return {
    subject: `Booking confirmed — ${payload.operation_reference}`,
    text: [
      `Hi ${greeting},`,
      "",
      `The booking for ${booking.client_name} is confirmed.`,
      "",
      ...details,
      "",
      "Please use the confirmed terms above for dispatch.",
      "",
      "Tango Logistics",
    ].join("\n"),
    html: `<p>Hi ${escapeHtml(greeting)},</p><p>The booking for <strong>${escapeHtml(booking.client_name)}</strong> is confirmed.</p>${htmlList(details)}<p>Please use the confirmed terms above for dispatch.</p><p>Tango Logistics</p>`,
  };
}
