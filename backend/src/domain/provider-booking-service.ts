import type { ToolCallScope } from "./operation-read-service";
import type { ProviderFlowState, ProviderOperation } from "./provider-quote-service";
import { ToolError } from "./tool-error";

export type ProviderBookingToolName = "reschedule_booking" | "cancel_booking";
export type ProviderBookingTarget = { booking_id: string; booking_revision: string; operation_revision: string; mandate_id: string };
export type ProviderBooking = {
  operation: ProviderOperation; pickup_window: { start_at: string; end_at: string };
  confirmed_price: number; currency: string; payment_term_days: number | null;
  requires_reconfirmation: boolean;
};
export type ProviderBookingResult =
  { status: "applied" | "requires_escalation"; reason_code: string | null; commitment_created: false }
  | { booking_status: "cancelled"; operation_status: "sourcing"; commitment_created: false; client_email_queued: false };
export interface ProviderBookingRepository {
  execute(scope: ToolCallScope, name: ProviderBookingToolName, id: string, args: object,
    target: ProviderBookingTarget | null): Promise<ProviderBookingResult>;
}

/** Changes an existing provider-owned reservation, never its client's mandate. */
export class ProviderBookingService {
  private readonly scope: ToolCallScope;
  constructor(scope: ToolCallScope, private readonly repository: ProviderBookingRepository,
    private readonly state: () => ProviderFlowState | undefined) { this.scope = Object.freeze({ ...scope }); }

  async execute(name: ProviderBookingToolName, args: unknown, id: string): Promise<ProviderBookingResult> {
    if (this.scope.persona !== "provider") throw new ToolError("not_authorized", "Only the authenticated provider can change this booking.");
    if (typeof id !== "string" || !id.trim()) this.invalid();
    this.object(args);
    const keys = name === "reschedule_booking" ? ["operation_reference", "reason", "proposed_pickup_window"] : ["operation_reference", "reason"];
    if (Object.keys(args).some((key) => !keys.includes(key)) || typeof args.reason !== "string" || !args.reason.trim()
      || ("operation_reference" in args && (typeof args.operation_reference !== "string" || !/^OP-[0-9]{6,}$/.test(args.operation_reference)))) this.invalid();
    if (name === "reschedule_booking") {
      const window = args.proposed_pickup_window;
      this.object(window);
      if (Object.keys(window).length !== 2 || !this.timestamp(window.start_at) || !this.timestamp(window.end_at)
        || Date.parse(window.start_at) >= Date.parse(window.end_at)) this.invalid();
    }
    const state = this.state();
    const reference = typeof args.operation_reference === "string" ? args.operation_reference : state?.operation?.operation_reference;
    return this.repository.execute(this.scope, name, id, args, reference && state?.bookingTargets?.[reference] || null);
  }
  private object(value: unknown): asserts value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) this.invalid();
  }
  private timestamp(value: unknown): value is string {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) return false;
    return new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);
  }
  private invalid(): never {
    throw new ToolError("invalid_arguments", "Provide an exact operation reference when selecting, a nonempty reason, and for rescheduling an ordered pickup window with timezone. Do not supply IDs, price changes, mandate terms or evidence.");
  }
}
