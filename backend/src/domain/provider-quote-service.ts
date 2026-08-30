import type { ToolCallScope } from "./operation-read-service";
import { ToolError } from "./tool-error";
import type { ProviderBooking, ProviderBookingTarget } from "./provider-booking-service";

export type ProviderQuoteToolName = "create_quote" | "decline_quote_request";
export type ProviderOperation = {
  operation_reference: string; container_type: string; gross_weight_kg: number;
  pickup_location: string; delivery_location: string; empty_return_depot: string;
  operational_constraints: string[]; cargo_notes: string | null;
};
export type ProviderCommandTarget = {
  operation_revision: string; quote_request_id: string; mandate_id: string; previous_quote_id: string | null;
};
export type ProviderFlowState = {
  profile: "provider_inbound_entry" | "provider_quote" | "provider_reschedule" | "provider_cancel_booking" | "provider_booking_escalation" | "provider_unavailable" | "terminal";
  intent: string;
  operation: ProviderOperation | null;
  candidates: ProviderOperation[];
  bookingCandidates?: ProviderBooking[];
  bookingTargets?: Record<string, ProviderBookingTarget>;
  // Private concurrency context: never put this map in prompts/tool results.
  commandTargets: Record<string, ProviderCommandTarget>;
  lastQuote: { quote_version: number; verdict: string; price_range: { min: number; max: number; currency: string }; negotiation_rounds_remaining: number } | null;
};
export type ProviderQuoteResult = {
  operation_reference: string; quote_version: number; verdict: "dentro" | "contraoferta" | "fuera";
  reason_codes: string[]; negotiation_remaining: boolean; negotiation_rounds_remaining: number;
} | { status: "declined"; commitment_created: false };
export interface ProviderQuoteRepository {
  getState(scope: ToolCallScope): Promise<ProviderFlowState>;
  execute(scope: ToolCallScope, name: ProviderQuoteToolName, id: string, args: object,
    target: ProviderCommandTarget | null): Promise<ProviderQuoteResult>;
}

/** Conversational consent stays in the agent; authorization/evaluation stay in SQL. */
export class ProviderQuoteService {
  private readonly scope: ToolCallScope;
  private state?: ProviderFlowState;
  constructor(scope: ToolCallScope, private readonly repository: ProviderQuoteRepository) {
    this.scope = Object.freeze({ ...scope });
  }
  get currentState(): ProviderFlowState | undefined { return this.state; }

  async getState(): Promise<ProviderFlowState> {
    this.authorize();
    this.state = await this.repository.getState(this.scope);
    return this.state;
  }

  async execute(name: ProviderQuoteToolName, args: unknown, id: string): Promise<ProviderQuoteResult> {
    this.authorize();
    if (typeof id !== "string" || !id.trim()) this.invalid();
    this.object(args);
    if ("operation_reference" in args && (typeof args.operation_reference !== "string"
      || !/^OP-[0-9]{6,}$/.test(args.operation_reference))) this.invalid();
    if (name === "create_quote") this.validateQuote(args);
    else {
      if (Object.keys(args).some((key) => !["operation_reference", "reason", "details"].includes(key))
        || !["no_capacity", "unavailable_window", "price_terms", "route_unsupported", "operational_constraints", "other"].includes(String(args.reason))
        || typeof args.reason !== "string"
        || ("details" in args && (typeof args.details !== "string" || !args.details.trim()))) this.invalid();
    }
    const reference = typeof args.operation_reference === "string" ? args.operation_reference : this.state?.operation?.operation_reference;
    // Replay must reach SQL even after terminal/refresh removes command targets.
    const target = reference && this.state?.commandTargets[reference] || null;
    return this.repository.execute(this.scope, name, id, args, target);
  }

  private validateQuote(args: Record<string, unknown>): void {
    const required = ["price_range", "proposed_pickup_window", "payment_term_days", "valid_until", "conditions"];
    if (required.some((key) => !(key in args))
      || Object.keys(args).some((key) => ![...required, "operation_reference"].includes(key))) this.invalid();
    const price = args.price_range;
    this.object(price);
    if (Object.keys(price).length !== 3 || !this.money(price.min) || !this.money(price.max)
      || price.min > price.max || typeof price.currency !== "string" || !/^[A-Z]{3}$/.test(price.currency)) this.invalid();
    const window = args.proposed_pickup_window;
    this.object(window);
    if (Object.keys(window).length !== 2 || !this.timestamp(window.start_at) || !this.timestamp(window.end_at)
      || Date.parse(window.start_at) >= Date.parse(window.end_at)) this.invalid();
    if (!this.timestamp(args.valid_until) || typeof args.payment_term_days !== "number"
      || !Number.isInteger(args.payment_term_days) || args.payment_term_days < 0 || args.payment_term_days > 2147483647) this.invalid();
    this.object(args.conditions);
    const notes = args.conditions.notes;
    if (Object.keys(args.conditions).length !== 1 || !Array.isArray(notes)
      || notes.some((note) => typeof note !== "string" || !note.trim()) || new Set(notes).size !== notes.length) this.invalid();
    // Expiry is checked by SQL after receipt replay, using the database clock.
  }

  private money(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 999999999999.99 && Number(value.toFixed(2)) === value;
  }
  private timestamp(value: unknown): value is string {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) return false;
    return new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);
  }
  private object(value: unknown): asserts value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) this.invalid();
  }
  private authorize(): void {
    if (this.scope.persona !== "provider") throw new ToolError("not_authorized", "Only the authenticated provider can submit this quote.");
  }
  private invalid(): never {
    throw new ToolError("invalid_arguments", "Use only the documented quote fields: a positive ordered price range with two decimals, currency, exact zoned window, integer payment days, expiry and condition notes. Do not supply IDs, verdicts or evidence.");
  }
}
