import type { SupabaseClient } from "@supabase/supabase-js";
import { isProviderOutboundPurpose } from "../../domain/call-flow";
import {
  PROVIDER_CONTACT_RPCS,
  type AdvanceSourcingRoundResult,
  type BeginProviderContactArguments,
  type BeginProviderContactResult,
  type ClaimedProviderContact,
  type FinishProviderContactArguments,
  type FinishProviderContactResult,
  type ProviderAttempt,
  type ProviderCallStatus,
  type RecordProviderCallStatusArguments,
  type RecordProviderCallStatusResult,
} from "../../domain/provider-contact-contract";

type RpcError = { code?: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAttempt(value: unknown): value is ProviderAttempt {
  return value === 1 || value === 2 || value === 3;
}

function isProviderCallStatus(value: unknown): value is ProviderCallStatus {
  return value === "queued" || value === "initiated" || value === "ringing"
    || value === "in-progress" || value === "completed" || value === "busy"
    || value === "failed" || value === "no-answer" || value === "canceled";
}

function isClaimedProviderContact(value: unknown): value is ClaimedProviderContact {
  return isRecord(value)
    && isNonEmptyString(value.outbox_id)
    && isNonEmptyString(value.call_id)
    && isNonEmptyString(value.lock_token)
    && isNonEmptyString(value.operation_id)
    && isNonEmptyString(value.round_id)
    && isNonEmptyString(value.quote_request_id)
    && isNonEmptyString(value.provider_id)
    && isNonEmptyString(value.provider_phone)
    && isProviderOutboundPurpose(value.purpose)
    && isAttempt(value.attempt);
}

function isBeginResult(value: unknown): value is BeginProviderContactResult {
  return isRecord(value) && typeof value.should_dial === "boolean";
}

function isDispatchState(value: unknown): value is FinishProviderContactResult["dispatch_state"] {
  return value === "prepared" || value === "dispatching" || value === "accepted"
    || value === "unknown" || value === "failed";
}

function isFinishResult(value: unknown): value is FinishProviderContactResult {
  return isRecord(value) && isDispatchState(value.dispatch_state) && typeof value.persisted === "boolean";
}

function isRecordStatusResult(value: unknown): value is RecordProviderCallStatusResult {
  return isRecord(value)
    && typeof value.accepted === "boolean"
    && typeof value.retry_scheduled === "boolean"
    && (value.next_attempt === null || isAttempt(value.next_attempt));
}

function isAdvanceResult(value: unknown): value is AdvanceSourcingRoundResult {
  return isRecord(value)
    && (value.round_id === null || isNonEmptyString(value.round_id))
    && (value.status === null || value.status === "active" || value.status === "selected"
      || value.status === "exhausted" || value.status === "superseded")
    && isNonEmptyString(value.operation_status)
    && isNonEmptyString(value.reason);
}

function scalarResult(data: unknown, name: string): unknown {
  if (Array.isArray(data)) throw new Error(`${name} returned an array; expected scalar jsonb`);
  return data;
}

export interface ProviderContactRepository {
  claimNext(): Promise<ClaimedProviderContact | null>;
  begin(input: BeginProviderContactArguments): Promise<BeginProviderContactResult>;
  finish(input: FinishProviderContactArguments): Promise<FinishProviderContactResult>;
  recordStatus(input: RecordProviderCallStatusArguments): Promise<RecordProviderCallStatusResult>;
  advance(operationId: string): Promise<AdvanceSourcingRoundResult>;
}

export class SupabaseProviderContactRepository implements ProviderContactRepository {
  constructor(private readonly client: SupabaseClient) {}

  async claimNext(): Promise<ClaimedProviderContact | null> {
    const { data, error } = await this.client.rpc(PROVIDER_CONTACT_RPCS.claim);
    this.throwRpcError(error);
    const result = scalarResult(data, PROVIDER_CONTACT_RPCS.claim);
    if (result === null) return null;
    if (!isClaimedProviderContact(result)) throw new Error("Invalid provider contact claim result");
    return result;
  }

  async begin(input: BeginProviderContactArguments): Promise<BeginProviderContactResult> {
    const { data, error } = await this.client.rpc(PROVIDER_CONTACT_RPCS.begin, input);
    this.throwRpcError(error);
    const result = scalarResult(data, PROVIDER_CONTACT_RPCS.begin);
    if (!isBeginResult(result)) throw new Error("Invalid provider contact begin result");
    return result;
  }

  async finish(input: FinishProviderContactArguments): Promise<FinishProviderContactResult> {
    const { data, error } = await this.client.rpc(PROVIDER_CONTACT_RPCS.finish, input);
    this.throwRpcError(error);
    const result = scalarResult(data, PROVIDER_CONTACT_RPCS.finish);
    if (!isFinishResult(result)) throw new Error("Invalid provider contact finish result");
    return result;
  }

  async recordStatus(input: RecordProviderCallStatusArguments): Promise<RecordProviderCallStatusResult> {
    if (!isProviderCallStatus(input.p_status)) throw new Error("Invalid provider call status");
    const { data, error } = await this.client.rpc(PROVIDER_CONTACT_RPCS.status, input);
    this.throwRpcError(error);
    const result = scalarResult(data, PROVIDER_CONTACT_RPCS.status);
    if (!isRecordStatusResult(result)) throw new Error("Invalid provider call status result");
    return result;
  }

  async advance(operationId: string): Promise<AdvanceSourcingRoundResult> {
    if (!isNonEmptyString(operationId)) throw new Error("Operation ID is required");
    const { data, error } = await this.client.rpc(PROVIDER_CONTACT_RPCS.advance, {
      p_operation_id: operationId,
    });
    this.throwRpcError(error);
    const result = scalarResult(data, PROVIDER_CONTACT_RPCS.advance);
    if (!isAdvanceResult(result)) throw new Error("Invalid sourcing round advance result");
    return result;
  }

  private throwRpcError(error: RpcError | null): void {
    if (error) throw error;
  }
}
