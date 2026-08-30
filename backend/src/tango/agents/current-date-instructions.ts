/** Server clock, never a hardcoded demo year or a model guess. */
export class CurrentDateInstructions {
  constructor(private readonly now: () => Date = () => new Date()) {}

  build(): string {
    const instant = this.now();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit",
      day: "2-digit", weekday: "long",
    }).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)!.value;
    return `# CURRENT DATE (SERVER CONTEXT)
- Today at the demo's Buenos Aires reference location: ${part("year")}-${part("month")}-${part("day")} (${part("weekday")}). Current year: ${part("year")}.
- Current UTC date: ${instant.toISOString().slice(0, 10)}. Use the pickup locality for shipment timestamps; the reference location is not a timezone override for other routes.
- Dates stated without a year use the current year above. Do not ask for the year routinely. Honor a different year explicitly stated by the caller or already verified in the operation.
- Resolve today, tomorrow and weekdays from this current date, not from training knowledge or example conversations. A bare weekday means its next occurrence (today if still applicable).
- If an inferred date is already past, invalid or conflicts with the stated weekday, ask one brief clarification. Never silently roll it into next year. An explicit relative date such as tomorrow may cross a year boundary.
- Do not recite today's date, the year or timezone unless needed to resolve ambiguity.`;
  }
}
