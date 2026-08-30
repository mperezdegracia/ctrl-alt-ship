import type { ConferenceMove, SupervisorCall, TwilioGateway } from "./twilio-gateway";

export type EscalationHandoff = Readonly<{
  callSid: string;
  conferenceName: string;
  supervisorPhone: string;
}>;

type TwilioHandoffPort = Pick<TwilioGateway, "callSupervisorToConference" | "moveCallToConference">;

/** Coordinates a one-shot live handoff; persistence remains the caller's concern. */
export class EscalationHandoffCoordinator {
  private handoff?: EscalationHandoff;
  private farewellResponseId?: string;
  private awaitingFarewellResponse = false;
  private moved = false;

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
    if (!this.handoff || this.moved || responseId !== this.farewellResponseId) return false;
    await this.twilio.moveCallToConference({
      callSid: this.handoff.callSid,
      conferenceName: this.handoff.conferenceName,
    } satisfies ConferenceMove);
    await this.twilio.callSupervisorToConference({
      conferenceName: this.handoff.conferenceName,
      to: this.handoff.supervisorPhone,
    } satisfies SupervisorCall);
    this.moved = true;
    return true;
  }
}
