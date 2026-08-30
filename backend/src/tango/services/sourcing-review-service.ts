import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { SourcingJudge, SourcingReview } from "../agents/sourcing-judge";

const preparedSchema = z.object({
  ready: z.literal(true),
  input_hash: z.string().min(1),
  context: z.object({
    operation_id: z.string().uuid(),
    selected_quote: z.object({ id: z.string().uuid() }).passthrough(),
    mandate: z.object({ id: z.string().uuid() }).passthrough(),
  }).passthrough(),
});

type Decision = {
  finalized?: boolean; reason?: string; booking_id?: string; review_id?: string; judge_review_id?: string;
};
type Logger = {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

export class SourcingReviewService {
  private readonly retryAfter = new Map<string, { inputHash: string; until: number }>();

  constructor(
    private readonly database: SupabaseClient,
    private readonly judge: SourcingJudge,
    private readonly logger: Logger,
  ) {}

  async finalize(operationId: string): Promise<Decision> {
    const { data, error } = await this.database.rpc("prepare_sourcing_review", {
      p_operation_id: operationId,
    });
    if (error) throw error;
    if (data?.ready !== true) {
      return data ?? { finalized: false, reason: "not_ready" };
    }
    const prepared = preparedSchema.parse(data);
    if (prepared.context.operation_id !== operationId) throw new Error("sourcing_review_scope_mismatch");
    const fields = { operation_id: operationId, quote_id: prepared.context.selected_quote.id,
      mandate_id: prepared.context.mandate.id, input_hash: prepared.input_hash, model: this.judge.model };
    const cached = await this.database.from("sourcing_judge_reviews").select("id")
      .eq("operation_id", operationId).eq("input_hash", prepared.input_hash).maybeSingle();
    if (cached.error) throw cached.error;

    if (!cached.data) {
      const retry = this.retryAfter.get(operationId);
      if (retry?.inputHash === prepared.input_hash && retry.until > Date.now()) {
        return { finalized: false, reason: "judge_retry_pending" };
      }
      const started = Date.now();
      this.logger.info("sourcing.judge_started", fields);
      let review: SourcingReview;
      try {
        review = await this.judge.review(prepared.context);
      } catch (error) {
        this.retryAfter.set(operationId, { inputHash: prepared.input_hash, until: Date.now() + 60_000 });
        this.logger.error("sourcing.judge_failed", { ...fields, error, duration_ms: Date.now() - started });
        return { finalized: false, reason: "judge_unavailable" };
      }
      this.retryAfter.delete(operationId);
      const saved = await this.database.rpc("record_sourcing_review", {
        p_operation_id: operationId, p_input_hash: prepared.input_hash,
        p_review: review, p_model: this.judge.model,
      });
      if (saved.error) throw saved.error;
      if (!saved.data?.saved) {
        this.logger.info("sourcing.judge_stale", fields);
        return { finalized: false, reason: "stale_review" };
      }
      this.logger.info("sourcing.judge_completed", { ...fields,
        review_id: saved.data.review_id, assessment: review.assessment,
        duration_ms: Date.now() - started });
    }

    // SQL rechecks the current candidate/context. Neither an old review nor a
    // direct call to this RPC can bypass the gate after the migration is applied.
    const finalized = await this.database.rpc("finalize_operation_sourcing", { p_operation_id: operationId });
    if (finalized.error) throw finalized.error;
    return { ...finalized.data, review_id: finalized.data?.review_id ?? finalized.data?.judge_review_id };
  }
}
