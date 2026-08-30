import type { ToolCallScope } from "./operation-read-service";
import { ToolError } from "./tool-error";

export type OperationFields = {
  container_type?: string;
  gross_weight_kg?: number;
  pickup_location?: string;
  delivery_location?: string;
  empty_return_depot?: string;
  operational_constraints?: string[];
  cargo_notes?: string | null;
};

export type ClientToolName = "create_operation" | "update_operation" | "confirm_mandate" | "cancel_operation";
export type ClientCommandContext = { expected_operation_revision: string | null };
export type ClientProfile = "client_entry" | "client_create" | "client_update" | "client_confirm" | "terminal";
export type MandateTerms = {
  price_cap: number;
  currency: string;
  action_windows: Array<{ start_at: string; end_at: string }>;
  minimum_payment_term_days: number;
};
export type ClientFlowState = {
  operationRevision?: string;
  currentMandate?: (MandateTerms & { version: number }) | null;
  operationChanges?: Partial<Record<keyof OperationFields, { before: unknown; after: unknown }>>;
  profile: ClientProfile;
  intent: "undecided" | "create" | "update" | "cancel";
  operation: ({ [K in keyof Required<OperationFields>]: Required<OperationFields>[K] | null } & {
    operation_reference: string;
    status: string;
    missing_fields: string[];
    mandate_confirmation_required: boolean;
  }) | null;
};

export type ClientMutationResult = {
  operation_reference: string;
  status: string;
  missing_fields: string[];
  next_profile: "client_create" | "client_update" | "client_confirm";
  mandate_confirmation_required?: boolean;
} | { operation_reference: string; mandate_version: number; status: "sourcing"; next_profile: "terminal" }
  | { operation_reference: string; status: "cancelled"; provider_email_queued: false; next_profile: "terminal" };

export interface ClientOperationRepository {
  getState(scope: ToolCallScope): Promise<ClientFlowState>;
  execute(scope: ToolCallScope, toolName: ClientToolName, toolCallId: string, args: object, context?: ClientCommandContext): Promise<ClientMutationResult>;
}

export class ClientOperationService {
  private readonly scope: ToolCallScope;
  private state?: ClientFlowState;

  constructor(scope: ToolCallScope, private readonly repository: ClientOperationRepository) {
    this.scope = Object.freeze({ ...scope });
  }

  async getState(): Promise<ClientFlowState> {
    this.assertClient();
    this.state = await this.repository.getState(this.scope);
    return this.state;
  }

  async create(args: unknown, toolCallId: string): Promise<ClientMutationResult> {
    this.assertClient();
    this.assertToolCallId(toolCallId);
    this.validateFields(args, false);
    return this.repository.execute(this.scope, "create_operation", toolCallId, args);
  }

  async update(args: unknown, toolCallId: string): Promise<ClientMutationResult> {
    this.assertClient();
    this.assertToolCallId(toolCallId);
    this.assertObject(args);
    if (Object.keys(args).some((key) => !["operation_reference", "changes"].includes(key))) this.invalid();
    if ("operation_reference" in args
      && (typeof args.operation_reference !== "string" || !/^OP-[0-9]{6,}$/.test(args.operation_reference))) this.invalid();
    this.validateFields(args.changes, true);
    if (Object.keys(args.changes).length === 0) this.invalid();
    return this.repository.execute(this.scope, "update_operation", toolCallId, args);
  }

  async cancel(args: unknown, toolCallId: string): Promise<ClientMutationResult> {
    this.assertClient();
    this.assertToolCallId(toolCallId);
    this.assertObject(args);
    if (Object.keys(args).length !== 2
      || typeof args.operation_reference !== "string" || !/^OP-[0-9]{6,}$/.test(args.operation_reference)
      || typeof args.reason !== "string" || args.reason.trim() === "") {
      throw new ToolError("invalid_arguments", "Provide the exact operation_reference and a nonempty cancellation reason. No IDs or notification arguments are accepted.");
    }
    // Intent, ownership, terminal state and durable replay are enforced in SQL.
    return this.repository.execute(this.scope, "cancel_operation", toolCallId, args);
  }

  async confirm(args: unknown, toolCallId: string): Promise<ClientMutationResult> {
    this.assertClient();
    this.assertToolCallId(toolCallId);
    this.assertObject(args);
    const keys = ["price_cap", "currency", "action_windows", "minimum_payment_term_days"];
    const canInherit = this.state?.intent === "update" && Boolean(this.state.currentMandate);
    if ((!canInherit && ["price_cap", "currency", "action_windows"].some((key) => !(key in args)))
      || Object.keys(args).some((key) => !keys.includes(key))) this.invalidMandate();
    const price = args.price_cap;
    if ("price_cap" in args && (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price > 999999999999.99
      || Number(price.toFixed(2)) !== price)) this.invalidMandate();
    if ("currency" in args && (typeof args.currency !== "string" || !/^[A-Z]{3}$/.test(args.currency))) this.invalidMandate();
    const days = args.minimum_payment_term_days;
    if ("minimum_payment_term_days" in args && (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > 2147483647)) this.invalidMandate();
    if ("action_windows" in args && (!Array.isArray(args.action_windows) || args.action_windows.length === 0)) this.invalidMandate();
    for (const window of (args.action_windows ?? []) as unknown[]) {
      this.assertObject(window);
      if (Object.keys(window).length !== 2 || !this.isTimestamp(window.start_at) || !this.isTimestamp(window.end_at)
        || Date.parse(window.start_at) >= Date.parse(window.end_at)) this.invalidMandate();
    }
    // The database handles replay before state/revision checks, including after reconnect.
    return this.repository.execute(this.scope, "confirm_mandate", toolCallId, args, {
      expected_operation_revision: this.state?.operationRevision ?? null,
    });
  }

  private isTimestamp(value: unknown): value is string {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) return false;
    const date = value.slice(0, 10);
    return new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  }

  private invalidMandate(): never {
    throw new ToolError("invalid_arguments", "For a first mandate provide price cap, currency and pickup windows. Payment days are optional; omission sets no minimum payment delay. For an update with an existing mandate, omit unchanged terms. Supplied terms must have a positive price cap (two decimals), currency, explicit time-zone windows and nonnegative payment days. Do not provide IDs or evidence.");
  }

  private validateFields(value: unknown, allowNullNotes: boolean): asserts value is Record<string, unknown> {
    this.assertObject(value);
    const textFields = ["container_type", "pickup_location", "delivery_location", "empty_return_depot"];
    for (const [key, field] of Object.entries(value)) {
      if (textFields.includes(key) || key === "cargo_notes") {
        if (key === "cargo_notes" && allowNullNotes && field === null) continue;
        if (typeof field !== "string" || field.trim() === "") this.invalid();
      } else if (key === "gross_weight_kg") {
        // Match numeric(12,3) storage without silently rounding caller values.
        if (typeof field !== "number" || !Number.isFinite(field) || field <= 0
          || field > 999999999.999 || Number(field.toFixed(3)) !== field) this.invalid();
      } else if (key === "operational_constraints") {
        if (!Array.isArray(field) || field.some((item) => typeof item !== "string" || item.trim() === "")
          || new Set(field).size !== field.length) this.invalid();
      } else this.invalid();
    }
  }

  private assertObject(value: unknown): asserts value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) this.invalid();
  }

  private assertClient(): void {
    if (this.scope.persona !== "client") throw new ToolError("not_authorized", "Only the authenticated client can modify this operation.");
  }

  private assertToolCallId(value: string): void {
    if (typeof value !== "string" || value.trim() === "") this.invalid();
  }

  private invalid(): never {
    throw new ToolError("invalid_arguments", "Provide only the documented operation fields, with valid values. Internal IDs and commercial terms are not accepted here.");
  }
}
