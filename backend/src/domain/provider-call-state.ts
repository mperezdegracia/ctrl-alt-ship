/** Private state returned by authorized RPCs. Build model context using explicit projections. */
export type PickupWindow = { start_at: string; end_at: string };
export type ProviderOperation = {
  operation_reference: string; container_type: string | null; gross_weight_kg: number | null;
  pickup_location: string; delivery_location: string; empty_return_depot: string | null;
  operational_constraints: string[]; cargo_notes: string | null;
  currency?: string | null; pickup_window?: PickupWindow | null;
};
export type ProviderBookingSummary = {
  operation_reference: string;
  pickup_location: string | null;
  delivery_location: string | null;
  pickup_window: { start_at: string | null; end_at: string | null };
};
export type ProviderBooking = {
  operation: ProviderOperation; pickup_window: PickupWindow;
  confirmed_price: number; currency: string; payment_term_days: number | null;
  requires_reconfirmation: boolean;
};
/** booking_id is the observed current_booking_id; operation_revision protects the pointer. */
export type ProviderBookingTarget = {
  booking_id: string; operation_revision: string; mandate_id: string;
};
export type ProviderCommandTarget = {
  operation_revision: string; quote_request_id: string; mandate_id: string;
  round_id: string; previous_quote_id: string | null;
};
export type ProviderBookingSelectionName = "select_booking_for_reschedule" | "select_booking_for_cancellation";
export type ProviderBookingSelectionResult = {
  status: "selected"; operation_reference: string; intent: "reschedule" | "cancel_booking";
};
export type ProviderBookingResult =
  | { status: "applied" | "requires_escalation"; reason_code: string | null; commitment_created: false }
  | { booking_status: "cancelled"; operation_status: "sourcing" | "needs_follow_up";
      commitment_created: false; client_email_queued: false };
/** Event-only transition IDs. Never accept these from the model or project them into tool outputs. */
export type BookingTransition = {
  previous_booking_id: string | null; booking_id: string | null; current_booking_id: string | null;
};
export type ProviderLastQuote = {
  quote_version: number; verdict: string;
  price_range: { min: number; max: number; currency: string };
  negotiation_rounds_remaining: number;
  fixed_terms?: {
    proposed_pickup_window: PickupWindow; payment_term_days: number | null;
    valid_until: string | null; conditions: { notes: string[] } | null;
  };
};
export type ProviderOfferArguments = { price_range: { min: number; max: number }; currency?: string };
export type ProviderOfferResult = { status: "recorded" };
export type ProviderInboundState = {
  flow: "provider_inbound";
  profile: "provider_inbound_entry" | "provider_reschedule" | "provider_cancel_booking"
    | "provider_booking_escalation" | "provider_unavailable" | "terminal";
  intent: "undecided" | "reschedule" | "cancel_booking";
  bookings: ProviderBookingSummary[];
  selectedBooking: ProviderBooking | null;
  commandTarget: ProviderBookingTarget | null;
  lastResult: ProviderBookingResult | null;
};
export type ProviderOutboundState = {
  flow: "provider_outbound";
  profile: "provider_quote" | "provider_unavailable" | "terminal";
  intent: "quote";
  operation: ProviderOperation | null;
  commandTarget: ProviderCommandTarget | null;
  privatePriceLimit: { price_cap: number; currency: string } | null;
  lastQuote: ProviderLastQuote | null;
  lastOffer: { price_range: { min: number; max: number; currency: string } } | null;
};
export type ProviderCallState = ProviderInboundState | ProviderOutboundState;
export interface ProviderStateReader {
  getState(): Promise<ProviderCallState>;
  readonly currentState: ProviderCallState | undefined;
}
