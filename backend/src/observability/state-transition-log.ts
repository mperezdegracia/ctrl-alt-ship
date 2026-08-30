export interface DiagnosticLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** Log polling results on change or once per minute, not every worker tick. */
export class StateTransitionLog {
  private readonly states = new Map<string, { signature: string; at: number }>();
  constructor(private readonly logger: DiagnosticLogger, private readonly now = Date.now) {}

  observe(key: string, event: string, fields: Record<string, unknown>): void {
    const signature = JSON.stringify(fields);
    const previous = this.states.get(key);
    const at = this.now();
    if (previous?.signature === signature && at - previous.at < 60_000) return;
    this.states.set(key, { signature, at });
    this.logger.info(event, fields);
  }

  retain(keys: string[]): void {
    const active = new Set(keys);
    for (const key of this.states.keys()) if (!active.has(key)) this.states.delete(key);
  }
}
