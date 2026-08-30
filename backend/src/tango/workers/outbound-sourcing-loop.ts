import { setTimeout as delay } from "node:timers/promises";

type Logger = {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

/** One polling loop per backend process, independent of any caller session. */
export class OutboundSourcingLoop {
  private started = false;

  constructor(
    private readonly runOnce: () => Promise<void>,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.logger.info("sourcing.worker_started", { interval_ms: 5_000, mode: "async_loop" });

    let iteration = 0;
    while (true) {
      this.logger.info("sourcing.worker_poll", {
        iteration: ++iteration,
        queue_table: "public.outbox",
        job_type: "contact_provider",
        interval_ms: 5_000,
      });
      try {
        // Wait for dispatch/persistence, not for the phone conversation to end.
        await this.runOnce();
      } catch (error) {
        this.logger.error("sourcing.worker_failed", { error });
      }
      // Yield to HTTP requests and live calls; never overlap polling iterations.
      await delay(5_000);
    }
  }
}
