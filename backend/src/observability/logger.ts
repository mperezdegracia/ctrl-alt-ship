export type LogFields = Record<string, unknown>;

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACTED_KEY = /(authorization|api[-_]?key|secret|password|token)/i;

function configuredLevel(): LogLevel {
  const value = process.env.LOG_LEVEL?.toLowerCase();
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

function serialize(value: unknown, key = ""): unknown {
  if (REDACTED_KEY.test(key)) return "[REDACTED]";
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) return value.map((item) => serialize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        serialize(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

export class StructuredLogger {
  private readonly minimumLevel = configuredLevel();

  constructor(
    private readonly component: string,
    private readonly context: LogFields = {},
  ) {}

  child(context: LogFields): StructuredLogger {
    return new StructuredLogger(this.component, { ...this.context, ...context });
  }

  debug(event: string, fields: LogFields = {}): void {
    this.write("debug", event, fields);
  }

  info(event: string, fields: LogFields = {}): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.write("error", event, fields);
  }

  private write(level: LogLevel, event: string, fields: LogFields): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minimumLevel]) return;

    const record = serialize({
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      event,
      ...this.context,
      ...fields,
    });
    const line = JSON.stringify(record);

    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}
