import type { SupabaseClient } from "@supabase/supabase-js";

import { SmsDeliveryError, type SmsGateway } from "../services/sms-gateway";
import { prepareSmsPayload, renderSms } from "../services/sms-templates";

export type SmsOutboxJob = {
  id: string;
  operation_id: string;
  payload: unknown;
  idempotency_key: string;
  attempts: number;
  lock_token: string;
};

export type SmsOutboxRepository = {
  claim(limit: number): Promise<SmsOutboxJob[]>;
  complete(job: SmsOutboxJob, providerMessageId: string): Promise<void>;
  fail(job: SmsOutboxJob, errorCode: string, retryable: boolean): Promise<void>;
};

type Logger = {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

export class SupabaseSmsOutboxRepository implements SmsOutboxRepository {
  constructor(private readonly client: SupabaseClient) {}

  async claim(limit: number): Promise<SmsOutboxJob[]> {
    const { data, error } = await this.client.rpc("claim_sms_outbox", { p_limit: limit });
    if (error) throw error;
    return (data ?? []) as SmsOutboxJob[];
  }

  async complete(job: SmsOutboxJob, providerMessageId: string): Promise<void> {
    const { error } = await this.client.rpc("complete_sms_outbox", {
      p_outbox_id: job.id,
      p_lock_token: job.lock_token,
      p_provider_message_id: providerMessageId,
    });
    if (error) throw error;
  }

  async fail(job: SmsOutboxJob, errorCode: string, retryable: boolean): Promise<void> {
    const { error } = await this.client.rpc("fail_sms_outbox", {
      p_outbox_id: job.id,
      p_lock_token: job.lock_token,
      p_error_code: errorCode,
      p_retryable: retryable,
    });
    if (error) throw error;
  }
}

export class SmsOutboxWorker {
  private running = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repository: SmsOutboxRepository,
    private readonly gateway: SmsGateway,
    private readonly logger: Logger,
    private readonly batchSize = 10,
  ) {}

  start(intervalMs: number): void {
    if (this.timer) return;
    this.logger.info("sms.worker_started", { interval_ms: intervalMs, mode: this.gateway.mode, batch_size: this.batchSize });
    void this.runSafely();
    this.timer = setInterval(() => void this.runSafely(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const jobs = await this.repository.claim(this.batchSize);
      if (jobs.length) this.logger.info("sms.jobs_claimed", { count: jobs.length, mode: this.gateway.mode });
      for (const job of jobs) await this.deliver(job);
      return jobs.length;
    } finally {
      this.running = false;
    }
  }

  private async runSafely(): Promise<void> {
    try {
      const count = await this.runOnce();
      if (count > 0) this.logger.info("sms.worker_batch_completed", { count, mode: this.gateway.mode });
    } catch (error) {
      this.logger.error("sms.worker_poll_failed", { error });
    }
  }

  private async deliver(job: SmsOutboxJob): Promise<void> {
    const started = Date.now();
    this.logger.info("sms.delivery_started", {
      outbox_id: job.id, operation_id: job.operation_id, attempts: job.attempts, mode: this.gateway.mode,
    });
    try {
      const payload = prepareSmsPayload(job.payload);
      const rendered = renderSms(payload);
      const result = await this.gateway.deliver({
        ...rendered,
        to: payload.recipient_phone ?? "",
        phoneType: payload.recipient_phone_type,
        idempotencyKey: job.idempotency_key,
        operationId: job.operation_id,
        template: payload.template,
      });
      await this.repository.complete(job, result.providerMessageId);
      this.logger.info("sms.delivered", {
        duration_ms: Date.now() - started,
        outbox_id: job.id,
        operation_id: job.operation_id,
        template: payload.template,
        recipient_type: payload.recipient_type,
        attempts: job.attempts,
        mode: this.gateway.mode,
        preview: result.preview,
      });
    } catch (error) {
      const failure = error instanceof SmsDeliveryError
        ? { code: error.code, retryable: error.retryable }
        : { code: "sms_delivery_unavailable", retryable: true };
      try {
        await this.repository.fail(job, failure.code, failure.retryable);
      } catch (markFailureError) {
        this.logger.error("sms.failure_not_recorded", {
          outbox_id: job.id, operation_id: job.operation_id, error: markFailureError,
        });
        return;
      }
      this.logger.warn("sms.delivery_failed", {
        duration_ms: Date.now() - started,
        outbox_id: job.id,
        operation_id: job.operation_id,
        error_code: failure.code,
        retryable: failure.retryable,
        attempts: job.attempts,
        mode: this.gateway.mode,
      });
    }
  }
}
