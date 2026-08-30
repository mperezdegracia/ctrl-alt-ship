import type { SupervisorTransfer, TwilioGateway } from "./twilio-gateway";

export type EscalationHandoff = Readonly<{
  callSid: string;
  supervisorPhone: string;
}>;

type TwilioHandoffPort = Pick<TwilioGateway, "transferCallToSupervisor">;

/** Coordinates a one-shot live handoff; persistence remains the caller's concern. */
export class EscalationHandoffCoordinator {
  private handoff?: EscalationHandoff;
  private farewellResponseId?: string;
  private awaitingFarewellResponse = false;
  private transferred = false;

  constructor(private readonly twilio: TwilioHandoffPort) {}

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

  async onAudioStopped(responseId: string): Promise<boolean> {
    if (!this.handoff || this.transferred || responseId !== this.farewellResponseId) return false;
    await this.twilio.transferCallToSupervisor({
      callSid: this.handoff.callSid,
      to: this.handoff.supervisorPhone,
    } satisfies SupervisorTransfer);
    this.transferred = true;
    return true;
  }
}
