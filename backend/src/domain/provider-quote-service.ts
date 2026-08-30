import type { ToolCallScope } from "./operation-read-service";
import { ToolError } from "./tool-error";

export type ProviderQuoteArgs = {
  price_min: number;
  price_max: number;
  currency: string;
  pickup_window: { start_at: string; end_at: string };
  payment_term_days: number;
  valid_until: string;
  conditions: Record<string, unknown>;
};

export interface ProviderQuoteRepository {
  record(scope: ToolCallScope, toolCallId: string, args: ProviderQuoteArgs): Promise<unknown>;
}

/** Server-owned quote recording for an authenticated provider call. */
export class ProviderQuoteService {
  constructor(private readonly scope: ToolCallScope, private readonly repository: ProviderQuoteRepository) {}

  async record(args: unknown, toolCallId: string): Promise<unknown> {
    if (this.scope.persona !== "provider") throw new ToolError("not_authorized", "Only an authenticated provider can record a quote.");
    if (!toolCallId.trim() || !this.isArgs(args)) throw new ToolError("invalid_arguments", "Provide a complete, confirmed quote with prices, currency, pickup window, payment term, validity and conditions.");
    return this.repository.record(this.scope, toolCallId, args);
  }

  private isArgs(value: unknown): value is ProviderQuoteArgs {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const data = value as Record<string, unknown>;
    if (Object.keys(data).length !== 7 || !["price_min", "price_max", "currency", "pickup_window", "payment_term_days", "valid_until", "conditions"].every((key) => key in data)) return false;
    if (![data.price_min, data.price_max].every((price) => typeof price === "number" && Number.isFinite(price) && price > 0 && Number(price.toFixed(2)) === price)
      || (data.price_max as number) < (data.price_min as number)
      || typeof data.currency !== "string" || !/^[A-Z]{3}$/.test(data.currency)
      || typeof data.payment_term_days !== "number" || !Number.isInteger(data.payment_term_days) || data.payment_term_days < 0
      || typeof data.valid_until !== "string" || !Number.isFinite(Date.parse(data.valid_until))
      || !data.conditions || typeof data.conditions !== "object" || Array.isArray(data.conditions)) return false;
    const window = data.pickup_window;
    return Boolean(window && typeof window === "object" && !Array.isArray(window)
      && Object.keys(window as object).length === 2
      && typeof (window as Record<string, unknown>).start_at === "string"
      && typeof (window as Record<string, unknown>).end_at === "string"
      && Number.isFinite(Date.parse((window as Record<string, string>).start_at))
      && Number.isFinite(Date.parse((window as Record<string, string>).end_at))
      && Date.parse((window as Record<string, string>).start_at) < Date.parse((window as Record<string, string>).end_at));
  }
}
