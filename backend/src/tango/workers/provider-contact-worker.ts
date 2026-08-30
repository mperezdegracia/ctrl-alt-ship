import type {
  ClaimedProviderContact,
  FinishProviderContactArguments,
} from "../../domain/provider-contact-contract";
import type { ProviderContactRepository } from "../supabase/provider-contact-repository";
import { createTwilioOutboundCall } from "../telephony/twilio-outbound";

type Logger = {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

type Dialer = (job: ClaimedProviderContact) => Promise<{ sid: string }>;

export type ProviderContactWorkerDependencies = {
  repository: ProviderContactRepository;
  logger: Logger;
  dial?: Dialer;
  onRoundAdvanced?: (operationId: string) => Promise<void>;
};

/** Dispatches one durable provider-contact job; polling remains owned by OutboundSourcingLoop. */
export class ProviderContactWorker {
  constructor(private readonly dependencies: ProviderContactWorkerDependencies) {}

  async runOnce(): Promise<void> {
    const { repository, logger } = this.dependencies;
    const job = await repository.claimNext();
    if (!job) return;

    const fields = {
      outbox_id: job.outbox_id,
      call_id: job.call_id,
      operation_id: job.operation_id,
      quote_request_id: job.quote_request_id,
      provider_id: job.provider_id,
      round_id: job.round_id,
      attempt: job.attempt,
      purpose: job.purpose,
    };
    logger.info("sourcing.contact_claimed", fields);

    const begin = await repository.begin({
      p_outbox_id: job.outbox_id,
      p_call_id: job.call_id,
      p_lock_token: job.lock_token,
    });
    if (!begin.should_dial) {
      logger.info("sourcing.contact_not_authorized_to_dial", fields);
      await this.advance(job.operation_id);
      return;
    }

    let twilio: { sid: string };
    try {
      const dial = this.dependencies.dial ?? ((claimed: ClaimedProviderContact) => createTwilioOutboundCall({
        to: claimed.provider_phone,
        callRecordId: claimed.call_id,
        purpose: claimed.purpose,
      }));
      twilio = await dial(job);
    } catch (error) {
      await this.finishDispatchFailure(job, error, logger);
      await this.advance(job.operation_id);
      return;
    }

    try {
      const finished = await repository.finish({
        p_outbox_id: job.outbox_id,
        p_call_id: job.call_id,
        p_lock_token: job.lock_token,
        p_twilio_call_sid: twilio.sid,
        p_error: null,
        p_error_kind: null,
      });
      if (finished.persisted) {
        logger.info("sourcing.provider_call_started", { ...fields, twilio_call_sid: twilio.sid });
      } else {
        logger.error("sourcing.provider_call_sid_reconciliation_required", {
          ...fields,
          twilio_call_sid: twilio.sid,
          dispatch_state: finished.dispatch_state,
        });
      }
    } catch (error) {
      // The POST already succeeded. Retry persistence with the same SID only;
      // dispatching/unknown recovery never authorizes another Twilio POST.
      logger.error("sourcing.provider_call_sid_persist_failed", { ...fields, twilio_call_sid: twilio.sid, error });
      try {
        const retried = await repository.finish({
          p_outbox_id: job.outbox_id,
          p_call_id: job.call_id,
          p_lock_token: job.lock_token,
          p_twilio_call_sid: twilio.sid,
          p_error: null,
          p_error_kind: null,
        });
        if (!retried.persisted) {
          logger.error("sourcing.provider_call_sid_reconciliation_required", {
            ...fields,
            twilio_call_sid: twilio.sid,
            dispatch_state: retried.dispatch_state,
          });
        }
      } catch (retryError) {
        logger.error("sourcing.provider_call_sid_retry_failed", {
          ...fields,
          twilio_call_sid: twilio.sid,
          error: retryError,
        });
      }
    }

    await this.advance(job.operation_id);
  }

  private async finishDispatchFailure(job: ClaimedProviderContact, error: unknown, logger: Logger): Promise<void> {
    const input: FinishProviderContactArguments = {
      p_outbox_id: job.outbox_id,
      p_call_id: job.call_id,
      p_lock_token: job.lock_token,
      p_twilio_call_sid: null,
      p_error: error instanceof Error ? error.message.slice(0, 500) : "outbound_call_failed",
      p_error_kind: "ambiguous",
    };
    try {
      await this.dependencies.repository.finish(input);
      logger.info("sourcing.contact_failure_recorded", {
        outbox_id: job.outbox_id,
        call_id: job.call_id,
        error_kind: input.p_error_kind,
      });
    } catch (finishError) {
      // A failed finish remains a durable reconciliation issue; it must not trigger another POST here.
      logger.error("sourcing.contact_failure_persist_failed", {
        outbox_id: job.outbox_id,
        call_id: job.call_id,
        error: finishError,
      });
    }
  }

  private async advance(operationId: string): Promise<void> {
    await this.dependencies.repository.advance(operationId);
    if (this.dependencies.onRoundAdvanced) await this.dependencies.onRoundAdvanced(operationId);
  }
}
