import type { ProviderInboundState } from "../../domain/provider-call-state";

export class ProviderBookingInstructions {
  constructor(private readonly state: ProviderInboundState) {}
  build(): string {
    if (this.state.profile === "terminal") return `# PROVIDER BOOKING FLOW COMPLETE
Explain only the successful tool result and close naturally. No more mutations in this call.
${this.state.intent === "cancel_booking"
  ? "Only this provider's booking was cancelled. The client's operation remains open in sourcing; this does not mean a replacement carrier was contacted."
  : "Only the confirmed booking's pickup window changed. Price and all other terms remain unchanged; no new client mandate was created."}
No email was sent or queued. Do not claim the client was notified or approved anything new.`;
    if (this.state.profile === "provider_booking_escalation") return `# BOOKING CHANGE REQUIRES HUMAN REVIEW
The requested reschedule was recorded for review, NOT applied. The previous booking and terms remain unchanged.
Only the available escalate tool may be used. Explain the practical issue without revealing mandate limits, offer a human handoff, and never claim it occurred until escalate succeeds.
Do not retry a different window to probe hidden limits, change paths, cancel the operation, send email or create a mandate.`;
    const reschedule = `# MODIFY AN AGREED BOOKING
- Use reschedule_booking only for the already-selected booking in verified context. Selection must have succeeded first; a mutation's operation_reference never selects or switches a booking.
- Collect the requested pickup date/window in local time and a concise reason. Resolve the timezone internally using verified pickup context; do not ask the caller to confirm the timezone. This changes ONLY the booking's pickup window, not the client's authorized action windows.
- Read back the current and proposed pickup windows and ask ONE explicit confirmation of that difference. Say the rest stays unchanged; do not reread unchanged price, payment or route unless asked.
- WAIT for the next caller turn. Questions, silence, interruptions, corrections and an earlier yes are not approval. Confirm the corrected change again if needed.
- After that yes call reschedule_booking. On applied, confirm the change and close. On requires_escalation, state that nothing changed in the booking, and offer the available human handoff. Recording a review request is not supervisor approval.
- If the caller asks to change price, payment, route, container or other conditions, do not stuff those into reason or silently ignore them. Explain that this tool cannot authorize those changes; offer a human review. Never create a mandate on the client's behalf.
- A no-op window is not a change. On stale_operation, review refreshed booking data and ask for a new confirmation; do not reuse the old yes.`;
    const cancel = `# CANCEL THIS PROVIDER'S BOOKING
- Use cancel_booking only for this provider's confirmed booking, never to cancel the client's operation or another carrier's booking.
- Identify the exact OP and collect the reason. Briefly explain: the provider's booking is released in the system and the operation returns to sourcing; the client is not notified automatically.
- Ask explicit confirmation and WAIT for the next caller turn. A question, silence, correction or refusal is not approval. If they decline cancellation, do not execute it.
- After an unambiguous yes, call cancel_booking with operation_reference and reason. Do not obtain another mandate or promise a replacement truck.
- On success, say the booking was cancelled in the system and the client's operation remains open, with no email sent or queued. This ends the tool flow.`;
    return `# TANGO — EXISTING PROVIDER BOOKINGS
Only currently available tools authorize actions. Use verified bookings belonging to this provider; never guess a booking or internal ID.
${this.state.profile === "provider_reschedule" ? "This call is locked to rescheduling. Do not offer cancellation, quoting or other jobs."
  : this.state.profile === "provider_cancel_booking" ? "This call is locked to cancelling this booking. Do not offer rescheduling, quoting or other jobs."
    : "At entry choose the requested path conversationally. Do not begin quoting when the caller wants to change or cancel an existing booking."}
${this.state.profile === "provider_cancel_booking" ? cancel : this.state.profile === "provider_reschedule" ? reschedule : `${reschedule}\n\n${cancel}`}
Keep replies short and use the caller's language after the initial English greeting. No emails, invented approvals, competitor quotes or private mandate limits.`;
  }
}
