import type { ConferenceMove, SupervisorParticipant, SupervisorSummary, TwilioGateway } from "./twilio-gateway";

export type EscalationHandoff = Readonly<{
  callSid: string;
  conferenceName: string;
  supervisorPhone: string;
  summary: string;
  conferenceStatusCallbackUrl: string;
  participantStatusCallbackUrl: string;
  recordingStatusCallbackUrl: string;
}>;

type TwilioHandoffPort = Pick<TwilioGateway, "sendSupervisorSummary" | "addSupervisor" | "moveCallToConference">;

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

    await this.twilio.sendSupervisorSummary({ to: handoff.supervisorPhone, body: handoff.summary } satisfies SupervisorSummary);
    await this.twilio.addSupervisor({
      conferenceName: handoff.conferenceName,
      to: handoff.supervisorPhone,
      statusCallbackUrl: handoff.participantStatusCallbackUrl,
    } satisfies SupervisorParticipant);
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
    this.moved = true;
    await this.twilio.moveCallToConference({
      callSid: this.handoff.callSid,
      conferenceName: this.handoff.conferenceName,
      statusCallbackUrl: this.handoff.conferenceStatusCallbackUrl,
      recordingStatusCallbackUrl: this.handoff.recordingStatusCallbackUrl,
    } satisfies ConferenceMove);
    return true;
  }
}
