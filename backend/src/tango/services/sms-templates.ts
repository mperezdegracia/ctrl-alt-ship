import {
  prepareBookingEmailPayload,
  type BookingEmailPayload,
} from "./email-templates";

export type BookingSmsPayload = BookingEmailPayload & {
  recipient_phone: string | null;
  recipient_phone_type: "mobile" | "landline" | null;
};

export type RenderedSms = { body: string };

function text(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === "object") return null;
  return String(value).trim() || null;
}

function compact(value: string, maximumLength = 96): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximumLength ? normalized : `${normalized.slice(0, maximumLength - 3)}...`;
}

function limitBody(value: string, maximumLength = 459): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 3).trimEnd()}...`;
}

function money(value: number | string | null, currency: string): string | null {
  if (value === null) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return compact(`${currency} ${value}`.trim());
  return compact(`${currency} ${amount.toFixed(2)}`.trim());
}

function dateRange(start: string, end: string): string | null {
  if (!start && !end) return null;
  return compact([start, end].filter(Boolean).join(" to "));
}

/** Normalizes a durable booking-notification payload without rejecting the job. */
export function prepareBookingSmsPayload(value: unknown): BookingSmsPayload {
  const booking = prepareBookingEmailPayload(value);
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const phoneType = text(source.recipient_phone_type);
  return {
    ...booking,
    recipient_phone: text(source.recipient_phone),
    recipient_phone_type: phoneType === "mobile" || phoneType === "landline" ? phoneType : null,
  };
}

/**
 * A self-contained, compact confirmation. Providers do not have dashboard
 * access, so the dispatch-critical booking details belong in the SMS itself.
 */
export function renderBookingSms(payload: BookingSmsPayload): RenderedSms {
  const booking = payload.booking;
  const providerRecipient = payload.template === "booking_confirmation_provider"
    || payload.recipient_type === "provider";
  const route = [booking.pickup_location, booking.delivery_location].filter(Boolean).join(" -> ");
  const cargo = [booking.container_type, booking.gross_weight_kg === null ? null : `${booking.gross_weight_kg} kg`]
    .filter(Boolean).join(", ");
  const lines = [
    "Tango: booking confirmed.",
    payload.operation_reference ? `Reference: ${compact(payload.operation_reference, 64)}` : null,
    providerRecipient
      ? (booking.client_name ? `Client: ${compact(booking.client_name)}` : null)
      : (booking.provider_name ? `Provider: ${compact(booking.provider_name)}` : null),
    route ? `Route: ${compact(route, 180)}` : null,
    dateRange(booking.pickup_window_start, booking.pickup_window_end)
      ? `Pickup: ${dateRange(booking.pickup_window_start, booking.pickup_window_end)}` : null,
    cargo ? `Cargo: ${compact(cargo, 100)}` : null,
    money(booking.confirmed_price, booking.currency)
      ? `Confirmed price: ${money(booking.confirmed_price, booking.currency)}` : null,
    booking.payment_term_days === null ? null : `Payment term: ${compact(String(booking.payment_term_days), 32)} days from invoice.`,
    booking.confirmation_reference ? `Confirmation: ${compact(booking.confirmation_reference, 64)}` : null,
    providerRecipient ? "Use these terms for dispatch." : "Keep this confirmation for your records.",
  ].filter((line): line is string => Boolean(line));

  // Keep a malformed or unusually long source field from turning a
  // confirmation into an unbounded SMS cost while preserving readable lines.
  return { body: limitBody(lines.join("\n")) };
}
