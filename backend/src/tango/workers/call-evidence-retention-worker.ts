import type { SupabaseClient } from "@supabase/supabase-js";

type Logger = { info(event: string, fields?: Record<string, unknown>): void; error(event: string, fields?: Record<string, unknown>): void };

/** Purges expired transcripts and Twilio media once a day. */
export class CallEvidenceRetentionWorker {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly db: SupabaseClient, private readonly config: { accountSid?: string; authToken?: string }, private readonly logger: Logger) {}

  start(): void {
    if (this.timer) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), 24 * 60 * 60 * 1_000);
  }

  private async run(): Promise<void> {
    try {
      const { data, error } = await this.db.from("calls")
        .select("id,recording_sid").lte("evidence_expires_at", new Date().toISOString())
        .neq("recording_status", "deleted").limit(100);
      if (error) throw error;
      const ids: string[] = [];
      for (const row of data ?? []) {
        const call = row as { id: string; recording_sid: string | null };
        if (call.recording_sid && this.config.accountSid && this.config.authToken) {
          const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Recordings/${encodeURIComponent(call.recording_sid)}.json`, {
            method: "DELETE", headers: { Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}` },
          });
          if (!response.ok && response.status !== 404) throw new Error(`Twilio recording delete failed: ${response.status}`);
        }
        ids.push(call.id);
      }
      if (ids.length > 0) {
        const { error: purgeError } = await this.db.rpc("purge_expired_call_transcripts", { p_call_ids: ids });
        if (purgeError) throw purgeError;
        const { error: updateError } = await this.db.from("calls").update({ recording_status: "deleted", recording_sid: null }).in("id", ids);
        if (updateError) throw updateError;
      }
      this.logger.info("evidence.retention_completed", { purged_call_count: ids.length });
    } catch (error) { this.logger.error("evidence.retention_failed", { error }); }
  }
}
