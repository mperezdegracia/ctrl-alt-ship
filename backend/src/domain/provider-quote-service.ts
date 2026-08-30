import type { ToolCallScope } from "./operation-read-service";
import { ToolError } from "./tool-error";
import type { ProviderBooking, ProviderBookingTarget } from "./provider-booking-service";

export type ProviderQuoteToolName = "create_quote" | "decline_quote_request";
export type ProviderOperation = {
  operation_reference: string; container_type: string | null; gross_weight_kg: number | null;
  pickup_location: string; delivery_location: string; empty_return_depot: string | null;
  operational_constraints: string[]; cargo_notes: string | null;
  currency?: string | null; pickup_window?: { start_at: string; end_at: string } | null;
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
  // Agent-only guidance, not public operation data or tool arguments/results.
  privatePriceLimits?: Record<string, { price_cap: number; currency: string } | null>;
  lastQuote: {
    quote_version: number; verdict: string;
    price_range: { min: number; max: number; currency: string };
    negotiation_rounds_remaining: number;
    fixed_terms?: {
      proposed_pickup_window: { start_at: string; end_at: string };
      payment_term_days: number | null; valid_until: string | null; conditions: { notes: string[] } | null;
    };
  } | null;
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
    const required = ["price_range"];
    if (required.some((key) => !(key in args))
      || Object.keys(args).some((key) => ![...required, "operation_reference"].includes(key))) this.invalid();
    const price = args.price_range;
    this.object(price);
    if (Object.keys(price).length !== 2 || !this.money(price.min) || !this.money(price.max)
      || price.min > price.max) this.invalid();
    // Currency/window and any existing fixed terms are resolved by SQL, not model args.
  }

  private money(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 999999999999.99 && Number(value.toFixed(2)) === value;
  }
  private object(value: unknown): asserts value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) this.invalid();
  }
  private authorize(): void {
    if (this.scope.persona !== "provider") throw new ToolError("not_authorized", "Only the authenticated provider can submit this quote.");
  }
  private invalid(): never {
    throw new ToolError("invalid_arguments", "Send only price_range with positive min/max amounts and at most two decimals; optionally operation_reference to select a job. Do not send currency, dates, payment, expiry, conditions, IDs or verdicts.");
  }
}
