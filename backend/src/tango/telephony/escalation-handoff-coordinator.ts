import type { OpenAIRealtimeGateway } from "../realtime/openai-realtime-gateway";
import type { DiagnosticLogger } from "../../observability/state-transition-log";

export type EscalationHandoff = Readonly<{
  realtimeCallId: string;
  supervisorTargetUri: string;
}>;

type SipReferPort = Pick<OpenAIRealtimeGateway, "refer">;

export type EscalationReferResult = Readonly<{
  status: number;
  requestId: string | null;
  targetUri: string;
}>;

/** Coordinates a one-shot live handoff; persistence remains the caller's concern. */
export class EscalationHandoffCoordinator {
  private handoff?: EscalationHandoff;
  private farewellResponseId?: string;
  private awaitingFarewellResponse = false;
  private referred = false;
  private transferStarted = false;
  private cancelling = false;

  constructor(private readonly realtime: SipReferPort, private readonly logger?: DiagnosticLogger) {}

  get prepared(): boolean { return this.handoff !== undefined; }
  get referAccepted(): boolean { return this.referred; }
  get canReturn(): boolean { return !this.transferStarted && !this.cancelling; }

  /** Disarm only for explicit cancellation, never for voice activity. */
  interruptFarewell(): void {
    this.awaitingFarewellResponse = false;
    this.farewellResponseId = undefined;
  }

  onCallerSpeechStarted(): void {
    if (this.awaitingFarewellResponse || this.farewellResponseId) {
      this.logger?.info("escalation.speech_ignored_after_confirmation", {
        farewell_response_id: this.farewellResponseId,
      });
    }
  }

  async cancel(persist: () => Promise<void>): Promise<void> {
    if (!this.canReturn) throw new Error("The transfer has already started or cancellation is in progress");
    this.cancelling = true;
    this.interruptFarewell();
    try {
      await persist();
      this.handoff = undefined;
    } finally {
      this.cancelling = false;
    }
  }

  async prepare(handoff: EscalationHandoff): Promise<void> {
    if (this.handoff) throw new Error("Escalation handoff is already prepared");
    this.handoff = handoff;
  }

  trackFarewellResponse(responseId: string): void {
    if (!this.handoff) throw new Error("Escalation handoff is not prepared");
    if (this.farewellResponseId) throw new Error("Farewell response is already tracked");
    this.farewellResponseId = responseId;
  }

  beginFarewell(): void {
    if (!this.handoff) throw new Error("Escalation handoff is not prepared");
    if (!this.canReturn) throw new Error("The transfer has already started");
    this.interruptFarewell();
    this.awaitingFarewellResponse = true;
  }

  observeResponseCreated(responseId: string): boolean {
    if (!this.awaitingFarewellResponse || this.farewellResponseId) return false;
    this.awaitingFarewellResponse = false;
    this.trackFarewellResponse(responseId);
    return true;
  }

  async onAudioStopped(responseId: string): Promise<EscalationReferResult | undefined> {
    if (!this.handoff) return undefined;
    if (this.transferStarted || this.cancelling || responseId !== this.farewellResponseId) {
      this.logger?.info("escalation.audio_stop_ignored", { response_id: responseId,
        farewell_response_id: this.farewellResponseId, refer_accepted: this.referred });
      return undefined;
    }
    const started = Date.now();
    // Fence cancellation and duplicate audio events before the first await.
    // A failed network response does not prove that the transfer was rejected.
    this.transferStarted = true;
    this.logger?.info("escalation.refer_requested", { response_id: responseId,
      target_phone_suffix: this.handoff.supervisorTargetUri.slice(-4) });
    try {
      const result = await this.realtime.refer(this.handoff.realtimeCallId, this.handoff.supervisorTargetUri);
      this.referred = true;
      this.logger?.info("escalation.refer_accepted", { response_id: responseId,
        status: result.status, duration_ms: Date.now() - started, human_answer_confirmed: false });
      return { ...result, targetUri: this.handoff.supervisorTargetUri };
    } catch (error) {
      this.logger?.error("escalation.refer_request_failed", { response_id: responseId, duration_ms: Date.now() - started, error });
      throw error;
    }
  }
}
