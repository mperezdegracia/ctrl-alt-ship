import type { ToolCallScope } from "./call-flow";
import type {
  ProviderBooking,
  ProviderBookingResult,
  ProviderBookingTarget,
  ProviderBookingSelectionName,
  ProviderBookingSelectionResult,
  ProviderInboundState,
  ProviderOperation,
} from "./provider-call-state";
import { ToolError } from "./tool-error";

export type ProviderBookingToolName = "reschedule_booking" | "cancel_booking" | "decline_reschedule_alternatives";
export type { ProviderBookingSelectionName, ProviderBookingSelectionResult } from "./provider-call-state";
export type { ProviderBooking, ProviderBookingResult, ProviderBookingTarget, ProviderOperation } from "./provider-call-state";
export interface ProviderBookingRepository {
  getState(scope: ToolCallScope): Promise<ProviderInboundState>;
  select(scope: ToolCallScope, name: ProviderBookingSelectionName, id: string, operationReference: string): Promise<ProviderBookingSelectionResult>;
  execute(scope: ToolCallScope, name: ProviderBookingToolName, id: string, args: object,
    target: ProviderBookingTarget | null): Promise<ProviderBookingResult>;
}

/** Changes an existing provider-owned reservation, never its client's mandate. */
export class ProviderBookingService {
  private readonly scope: ToolCallScope;
  private state?: ProviderInboundState;
  constructor(scope: ToolCallScope, private readonly repository: ProviderBookingRepository,
  ) { this.scope = Object.freeze({ ...scope }); }

  get currentState(): ProviderInboundState | undefined { return this.state; }

  async getState(): Promise<ProviderInboundState> {
    this.authorize();
    this.state = await this.repository.getState(this.scope);
    return this.state;
  }

  async listBookings(): Promise<{ operations: ProviderInboundState["bookings"] }> {
    // A new read must reauthorize the active call/provider and current pointers;
    // a cached conversational snapshot is not authority to expose bookings.
    const state = await this.getState();
    return { operations: state.bookings };
  }

  async execute(name: ProviderBookingToolName, args: unknown, id: string): Promise<ProviderBookingResult> {
    this.authorize();
    if (typeof id !== "string" || !id.trim()) this.invalid();
    this.object(args);
    const keys = name === "reschedule_booking" ? ["operation_reference", "reason", "proposed_pickup_window", "proposed_pickup_local_window"] : ["operation_reference", "reason"];
    if (Object.keys(args).some((key) => !keys.includes(key)) || typeof args.reason !== "string" || !args.reason.trim()
      || ("operation_reference" in args && (typeof args.operation_reference !== "string" || !/^OP-[0-9]{6,}$/.test(args.operation_reference)))) this.invalid();
    if (name === "reschedule_booking") {
      const local = "proposed_pickup_local_window" in args;
      if (local === ("proposed_pickup_window" in args)) this.invalid();
      const window = local ? args.proposed_pickup_local_window : args.proposed_pickup_window;
      this.object(window);
      const start = local ? this.localTimestamp(window.start_at) : window.start_at;
      const end = local ? this.localTimestamp(window.end_at) : window.end_at;
      if (Object.keys(window).length !== 2 || !this.timestamp(start) || !this.timestamp(end)
        || Date.parse(start) >= Date.parse(end)) this.invalid();
    }
    const selectedReference = this.state?.selectedBooking?.operation.operation_reference;
    const reference = typeof args.operation_reference === "string" ? args.operation_reference : selectedReference;
    const target = reference && reference === selectedReference ? this.state?.commandTarget : null;
    return this.repository.execute(this.scope, name, id, args, target ?? null);
  }

  async select(name: ProviderBookingSelectionName, operationReference: unknown, id: string): Promise<ProviderBookingSelectionResult> {
    this.authorize();
    if (typeof id !== "string" || !id.trim() || typeof operationReference !== "string"
      || !/^OP-[0-9]{6,}$/.test(operationReference)) this.invalid();
    return this.repository.select(this.scope, name, id, operationReference);
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
  private localTimestamp(value: unknown): string | undefined {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
      ? `${value}Z` : undefined;
  }
  private invalid(): never {
    throw new ToolError("invalid_arguments", "Provide an exact operation reference when selecting, a nonempty reason, and for rescheduling one ordered proposed_pickup_local_window with local clock times and no timezone. The server resolves the saved pickup offset. Do not supply IDs, price changes, mandate terms or evidence.");
  }

  private authorize(): void {
    if (this.scope.persona !== "provider" || this.scope.direction !== "inbound"
      || this.scope.purpose !== "booking_management") {
      throw new ToolError("not_authorized", "Only an authenticated provider inbound booking call can change a booking.");
    }
  }
}
