import type { SupabaseClient } from "@supabase/supabase-js";

import {
  EmailPayloadError,
  parseBookingEmailPayload,
  renderBookingEmail,
} from "../services/email-templates";
import {
  EmailDeliveryError,
  type EmailGateway,
} from "../services/email-gateway";

export type EmailOutboxJob = {
  id: string;
  operation_id: string;
  payload: unknown;
  idempotency_key: string;
  attempts: number;
  lock_token: string;
};

export type EmailOutboxRepository = {
  claim(limit: number): Promise<EmailOutboxJob[]>;
  savePreview(job: EmailOutboxJob, message: { subject: string; text: string; html: string }): Promise<void>;
  complete(job: EmailOutboxJob, providerMessageId: string): Promise<void>;
  fail(job: EmailOutboxJob, errorCode: string, retryable: boolean): Promise<void>;
};

type Logger = {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class SupabaseEmailOutboxRepository implements EmailOutboxRepository {
  constructor(private readonly client: SupabaseClient) {}

  async claim(limit: number): Promise<EmailOutboxJob[]> {
    const { data, error } = await this.client.rpc("claim_email_outbox", { p_limit: limit });
    if (error) throw error;
    return (data ?? []) as EmailOutboxJob[];
  }

  async savePreview(job: EmailOutboxJob, message: { subject: string; text: string; html: string }): Promise<void> {
    const { error } = await this.client.rpc("record_email_preview", {
      p_outbox_id: job.id,
      p_lock_token: job.lock_token,
      p_subject: message.subject,
      p_text_body: message.text,
      p_html_body: message.html,
    });
    if (error) throw error;
  }

  async complete(job: EmailOutboxJob, providerMessageId: string): Promise<void> {
    const { error } = await this.client.rpc("complete_email_outbox", {
      p_outbox_id: job.id,
      p_lock_token: job.lock_token,
      p_provider_message_id: providerMessageId,
    });
    if (error) throw error;
  }

  async fail(job: EmailOutboxJob, errorCode: string, retryable: boolean): Promise<void> {
    const { error } = await this.client.rpc("fail_email_outbox", {
      p_outbox_id: job.id,
      p_lock_token: job.lock_token,
      p_error_code: errorCode,
      p_retryable: retryable,
    });
    if (error) throw error;
  }
}

export class EmailOutboxWorker {
  private running = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repository: EmailOutboxRepository,
    private readonly gateway: EmailGateway,
    private readonly logger: Logger,
    private readonly batchSize = 10,
  ) {}

  start(intervalMs: number): void {
    if (this.timer) return;
    this.logger.info("email.worker_started", { interval_ms: intervalMs, mode: this.gateway.mode, batch_size: this.batchSize });
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
      if (jobs.length) this.logger.info("email.jobs_claimed", { count: jobs.length, mode: this.gateway.mode });
      for (const job of jobs) await this.deliver(job);
      return jobs.length;
    } finally {
      this.running = false;
    }
  }

  private async runSafely(): Promise<void> {
    try {
      const count = await this.runOnce();
      if (count > 0) this.logger.info("email.worker_batch_completed", { count, mode: this.gateway.mode });
    } catch (error) {
      this.logger.error("email.worker_poll_failed", { error });
    }
  }

  private async deliver(job: EmailOutboxJob): Promise<void> {
    const started = Date.now();
    this.logger.info("email.delivery_started", { outbox_id: job.id, operation_id: job.operation_id,
      attempts: job.attempts, mode: this.gateway.mode });
    try {
      const payload = parseBookingEmailPayload(job.payload);
      if (!payload.recipient_email || !EMAIL_ADDRESS.test(payload.recipient_email)) {
        throw new EmailDeliveryError("recipient_email_missing_or_invalid", false);
      }

      const rendered = renderBookingEmail(payload);
      const result = await this.gateway.deliver({
        ...rendered,
        to: payload.recipient_email,
        idempotencyKey: job.idempotency_key,
        operationId: job.operation_id,
        template: payload.template,
      });
      if (result.preview) await this.repository.savePreview(job, rendered);
      await this.repository.complete(job, result.providerMessageId);
      this.logger.info("email.delivered", {
        duration_ms: Date.now() - started,
        outbox_id: job.id,
        operation_id: job.operation_id,
        template: payload.template,
        recipient_type: payload.recipient_type,
        attempts: job.attempts,
        mode: this.gateway.mode,
      });
    } catch (error) {
      const failure = this.classifyFailure(error);
      try {
        await this.repository.fail(job, failure.code, failure.retryable);
      } catch (markFailureError) {
        this.logger.error("email.failure_not_recorded", {
          outbox_id: job.id,
          operation_id: job.operation_id,
          error: markFailureError,
        });
        return;
      }
      this.logger.warn("email.delivery_failed", {
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

  private classifyFailure(error: unknown): { code: string; retryable: boolean } {
    if (error instanceof EmailPayloadError) return { code: error.code, retryable: false };
    if (error instanceof EmailDeliveryError) return { code: error.code, retryable: error.retryable };
    return { code: "email_delivery_unavailable", retryable: true };
  }
}
