export const emailTemplates = [
  "booking_confirmation_client",
  "booking_confirmation_provider",
] as const;

export type EmailTemplate = (typeof emailTemplates)[number];
export type EmailRecipientType = "client" | "provider";

export type BookingEmailPayload = {
  template: string;
  recipient_type: string;
  recipient_name: string | null;
  recipient_email: string | null;
  operation_reference: string;
  booking_id: string;
  booking: {
    confirmed_price: number | string | null;
    currency: string;
    pickup_window_start: string;
    pickup_window_end: string;
    payment_term_days: number | string | null;
    confirmation_reference: string | null;
    container_type: string | null;
    gross_weight_kg: number | string | null;
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

// Normalize only for rendering. No payload field rejects an email job;
// the mail transport remains responsible for accepting the recipient.
function fields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === "object") return null;
  return String(value).trim() || null;
}

export function prepareBookingEmailPayload(value: unknown): BookingEmailPayload {
  const source = fields(value);
  const booking = fields(source.booking);
  return {
    template: optionalText(source.template) ?? "",
    recipient_type: optionalText(source.recipient_type) ?? "",
    recipient_name: optionalText(source.recipient_name),
    recipient_email: optionalText(source.recipient_email),
    operation_reference: optionalText(source.operation_reference) ?? "",
    booking_id: optionalText(source.booking_id) ?? "",
    booking: {
      confirmed_price: optionalText(booking.confirmed_price),
      currency: optionalText(booking.currency) ?? "",
      pickup_window_start: optionalText(booking.pickup_window_start) ?? "",
      pickup_window_end: optionalText(booking.pickup_window_end) ?? "",
      payment_term_days: optionalText(booking.payment_term_days),
      confirmation_reference: optionalText(booking.confirmation_reference),
      container_type: optionalText(booking.container_type),
      gross_weight_kg: optionalText(booking.gross_weight_kg),
      pickup_location: optionalText(booking.pickup_location) ?? "",
      delivery_location: optionalText(booking.delivery_location) ?? "",
      client_name: optionalText(booking.client_name) ?? "",
      provider_name: optionalText(booking.provider_name) ?? "",
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
  if (!Number.isFinite(amount) || !currency) return `${currency} ${value}`.trim();
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
    ...(payload.operation_reference ? [`Operation: ${payload.operation_reference}`] : []),
    ...(booking.container_type !== null || booking.gross_weight_kg !== null
      ? [`Cargo: ${[booking.container_type, booking.gross_weight_kg === null ? null : `${booking.gross_weight_kg} kg`].filter(Boolean).join(", ")}`] : []),
    ...([booking.pickup_location, booking.delivery_location].some(Boolean)
      ? [`Route: ${[booking.pickup_location, booking.delivery_location].filter(Boolean).join(" → ")}`] : []),
    ...([booking.pickup_window_start, booking.pickup_window_end].some(Boolean)
      ? [`Pickup window: ${[booking.pickup_window_start, booking.pickup_window_end].filter(Boolean).join(" to ")}`] : []),
    ...(booking.confirmed_price === null ? [] : [`Confirmed price: ${formatMoney(booking.confirmed_price, booking.currency)}`]),
    ...(booking.payment_term_days === null ? [] : [`Payment term: ${booking.payment_term_days} days from invoice date`]),
    ...(booking.confirmation_reference ? [`Confirmation reference: ${booking.confirmation_reference}`] : []),
  ];
}

function htmlList(items: string[]): string {
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

export function renderBookingEmail(payload: BookingEmailPayload): RenderedEmail {
  const details = bookingDetails(payload);
  const booking = payload.booking;

  const subject = `Booking confirmed${payload.operation_reference ? ` — ${payload.operation_reference}` : ""}`;
  if (payload.template === "booking_confirmation_client" || payload.recipient_type === "client") {
    const greeting = payload.recipient_name ?? (booking.client_name || "there");
    const provider = booking.provider_name ? ` with ${booking.provider_name}` : "";
    return {
      subject,
      text: [
        `Hi ${greeting},`,
        "",
        `Your freight booking${provider} is confirmed.`,
        "",
        ...details,
        "",
        "This is a confirmation of the agreed booking; no reply is required.",
        "",
        "Tango Logistics",
      ].join("\n"),
      html: `<p>Hi ${escapeHtml(greeting)},</p><p>Your freight booking${booking.provider_name ? ` with <strong>${escapeHtml(booking.provider_name)}</strong>` : ""} is confirmed.</p>${htmlList(details)}<p>This is a confirmation of the agreed booking; no reply is required.</p><p>Tango Logistics</p>`,
    };
  }

  const greeting = payload.recipient_name ?? (booking.provider_name || "there");
  const client = booking.client_name ? ` for ${booking.client_name}` : "";
  return {
    subject,
    text: [
      `Hi ${greeting},`,
      "",
      `The booking${client} is confirmed.`,
      "",
      ...details,
      "",
      "Please use the confirmed terms above for dispatch.",
      "",
      "Tango Logistics",
    ].join("\n"),
    html: `<p>Hi ${escapeHtml(greeting)},</p><p>The booking${booking.client_name ? ` for <strong>${escapeHtml(booking.client_name)}</strong>` : ""} is confirmed.</p>${htmlList(details)}<p>Please use the confirmed terms above for dispatch.</p><p>Tango Logistics</p>`,
  };
}
