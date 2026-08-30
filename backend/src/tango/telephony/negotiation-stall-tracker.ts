/** Server-owned threshold for the no-progress escalation trigger. */
export class NegotiationStallTracker {
  private consecutiveCallerTurns = 0;

  constructor(private readonly threshold: number) {
    if (!Number.isInteger(threshold) || threshold < 1) throw new Error("Stall threshold must be a positive integer");
  }

  recordCallerTurn(): boolean {
    this.consecutiveCallerTurns += 1;
    return this.consecutiveCallerTurns >= this.threshold;
  }

  recordProgress(): void {
    this.consecutiveCallerTurns = 0;
  }
}
