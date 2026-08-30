type RpcResult = { data: unknown; error: unknown | null };
export type EvidenceRetentionDb = { rpc(name: string, args?: Record<string, unknown>): PromiseLike<RpcResult> };
export type EvidenceRetentionConfig = { accountSid?: string; authToken?: string };
export type EvidenceRetentionLogger = {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};
export type EvidenceRetentionFetch = (input: string, init?: RequestInit) => Promise<Response>;

type Recording = { recording_sid: string };
type RetentionJob = { call_id: string; transcript_pending: boolean; recordings: Recording[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJob(value: unknown): value is RetentionJob {
  return isRecord(value) && typeof value.call_id === "string" && value.call_id.length > 0
    && typeof value.transcript_pending === "boolean" && Array.isArray(value.recordings)
    && value.recordings.every((recording) => isRecord(recording)
      && typeof recording.recording_sid === "string" && /^RE[0-9a-f]{32}$/i.test(recording.recording_sid));
}

const DEFAULT_BATCH_SIZE = 100;
const DELETE_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 5 * 60 * 1_000;

/** Disposes expired evidence independently per call and recording SID. */
export class CallEvidenceRetentionWorker {
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: EvidenceRetentionDb,
    private readonly config: EvidenceRetentionConfig,
    private readonly logger: EvidenceRetentionLogger,
    private readonly dependencies: { fetch?: EvidenceRetentionFetch; deleteTimeoutMs?: number } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    void this.runSafely();
    this.timer = setInterval(() => void this.runSafely(), POLL_INTERVAL_MS);
    this.logger.info("evidence.retention_worker_started", { interval_ms: POLL_INTERVAL_MS, batch_size: DEFAULT_BATCH_SIZE });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const claimed = await this.db.rpc("claim_call_evidence_retention", { p_limit: DEFAULT_BATCH_SIZE });
      if (claimed.error) throw claimed.error;
      if (!Array.isArray(claimed.data)) throw new Error("Invalid retention claim result");
      if (!claimed.data.every(isJob)) throw new Error("Invalid retention claim job");
      const jobs = claimed.data;
      for (const job of jobs) await this.processJob(job);
      this.logger.info("evidence.retention_completed", { claimed_count: jobs.length });
      return jobs.length;
    } finally {
      this.running = false;
    }
  }

  private async runSafely(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error("evidence.retention_failed", { error_code: "retention_claim_failed" });
    }
  }

  private async processJob(job: RetentionJob): Promise<void> {
    if (job.transcript_pending) {
      try {
        const result = await this.db.rpc("purge_expired_call_transcripts", { p_call_ids: [job.call_id] });
        if (result.error) throw result.error;
      } catch {
        this.logger.error("evidence.transcript_purge_failed", { call_id: job.call_id });
      }
    }
    for (const recording of job.recordings) await this.deleteRecording(job.call_id, recording.recording_sid);
  }

  private async deleteRecording(callId: string, recordingSid: string): Promise<void> {
    let errorCode: string | null = null;
    if (!this.config.accountSid || !this.config.authToken) {
      errorCode = "twilio_credentials_missing";
    } else {
      try {
        const fetchImpl = this.dependencies.fetch ?? fetch;
        const controller = new AbortController();
        const timeoutMs = this.dependencies.deleteTimeoutMs ?? DELETE_TIMEOUT_MS;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid retention delete timeout");
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
          response = await fetchImpl(
            `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Recordings/${encodeURIComponent(recordingSid)}.json`,
            {
              method: "DELETE",
              headers: { Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}` },
              signal: controller.signal,
            },
          );
        } finally {
          clearTimeout(timeout);
        }
        if (response.status !== 204 && response.status !== 404) errorCode = `twilio_delete_http_${response.status}`;
      } catch (error) {
        errorCode = isAbortError(error) ? "twilio_delete_timeout" : "twilio_delete_failed";
      }
    }
    try {
      const result = await this.db.rpc("complete_call_recording_deletion", {
        p_call_id: callId,
        p_recording_sid: recordingSid,
        p_error: errorCode,
      });
      if (result.error) throw result.error;
      if (!isPersistedResult(result.data)) throw new Error("Recording deletion was not persisted");
      if (errorCode) this.logger.error("evidence.recording_deletion_failed", { call_id: callId, recording_sid: recordingSid, error_code: errorCode });
      else this.logger.info("evidence.recording_deleted", { call_id: callId, recording_sid: recordingSid });
    } catch {
      this.logger.error("evidence.recording_deletion_persist_failed", { call_id: callId, recording_sid: recordingSid, error_code: errorCode ?? "completion_persist_failed" });
    }
  }
}

function isPersistedResult(value: unknown): value is { persisted: true } {
  return isRecord(value) && value.persisted === true;
}

function isAbortError(value: unknown): boolean {
  return isRecord(value) && value.name === "AbortError";
}
