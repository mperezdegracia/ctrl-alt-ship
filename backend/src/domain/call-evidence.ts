export type EvidenceSegment = {
  id: string; callId: string; speaker: "caller" | "tango";
  content: string | null; recordedAt: string; contentDeletedAt: string | null;
};
export type EvidenceEvent = {
  id: string; callId: string | null; type: string; title: string;
  detail: string | null; occurredAt: string;
};
export const EVIDENCE_WINDOW_SECONDS = 30;

/** Navigation by timestamp is approximate, never proof of consent. */
export function matchEvidenceEvents(events: EvidenceEvent[], segments: EvidenceSegment[]) {
  return events.map((event) => {
    let nearest: EvidenceSegment | undefined;
    let distance = Infinity;
    for (const segment of segments) {
      if (segment.callId !== event.callId) continue;
      const delta = Math.abs(Date.parse(segment.recordedAt) - Date.parse(event.occurredAt));
      if (delta <= EVIDENCE_WINDOW_SECONDS * 1000 && (delta < distance
        || (delta === distance && segment.recordedAt < nearest!.recordedAt))) {
        nearest = segment;
        distance = delta;
      }
    }
    return { ...event, match: nearest ? { segmentId: nearest.id, offsetSeconds: distance / 1000 } : null };
  });
}
