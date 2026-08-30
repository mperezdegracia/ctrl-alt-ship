import type { OpenAIRealtimeGateway } from "../realtime/openai-realtime-gateway";

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

  constructor(private readonly realtime: SipReferPort) {}

  get prepared(): boolean { return this.handoff !== undefined; }

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
    this.awaitingFarewellResponse = true;
  }

  observeResponseCreated(responseId: string): boolean {
    if (!this.awaitingFarewellResponse || this.farewellResponseId) return false;
    this.awaitingFarewellResponse = false;
    this.trackFarewellResponse(responseId);
    return true;
  }

  async onAudioStopped(responseId: string): Promise<EscalationReferResult | undefined> {
    if (!this.handoff || this.referred || responseId !== this.farewellResponseId) return undefined;
    const result = await this.realtime.refer(this.handoff.realtimeCallId, this.handoff.supervisorTargetUri);
    this.referred = true;
    return { ...result, targetUri: this.handoff.supervisorTargetUri };
  }
}
