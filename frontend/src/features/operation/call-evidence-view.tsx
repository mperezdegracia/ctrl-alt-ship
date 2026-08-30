import Link from "next/link";
import { formatStatus, type DashboardCallEvidence } from "@/lib/dashboard-api";

type Event = DashboardCallEvidence["events"][number];
function timestamp(value: string, withDate = false) {
  return new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit", second: "2-digit",
    ...(withDate ? { day: "2-digit" as const, month: "short" as const, year: "numeric" as const } : {}),
    timeZone: "America/Argentina/Buenos_Aires", hourCycle: "h23" }).format(new Date(value));
}
function day(value: string) {
  return new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "long", year: "numeric", timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(value));
}
function elapsed(value: string, start?: string) {
  if (!start) return timestamp(value);
  const seconds = Math.floor((Date.parse(value) - Date.parse(start)) / 1000);
  if (seconds < 0) return timestamp(value);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function EventCard({ event }: { event: Event }) {
  return <article className="call-evidence-event" id={`event-${event.id}`} tabIndex={-1}>
    <div><span>{event.match ? "Horario cercano · aproximado" : event.callId ? "Evento de la llamada" : "Evento de la operación"}</span>
      <time dateTime={event.occurredAt}>{timestamp(event.occurredAt)}</time></div>
    <h3>{event.title}</h3>
    {event.detail && <p>{event.detail}</p>}
    <small>{event.type}{event.match && ` · ${event.match.offsetSeconds.toFixed(1)} s de diferencia`}</small>
  </article>;
}

export function CallEvidenceView({ evidence }: { evidence: DashboardCallEvidence }) {
  const selected = evidence.calls.find((call) => call.id === evidence.selectedCallId);
  const grouped = new Map<string, Event[]>();
  for (const event of evidence.events) {
    if (event.match) grouped.set(event.match.segmentId, [...(grouped.get(event.match.segmentId) ?? []), event]);
  }
  const timeline = [
    ...evidence.segments.map((segment) => ({ kind: "segment" as const, at: segment.recordedAt, id: segment.id, segment })),
    ...evidence.events.filter((event) => !event.match).map((event) => ({ kind: "event" as const, at: event.occurredAt, id: event.id, event })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));

  return <div className="call-evidence-workspace">
    <aside className="call-evidence-sidebar">
      <h2>Llamadas <span>{evidence.calls.length}</span></h2>
      <nav aria-label="Elegir llamada" className="call-evidence-calls">
        {evidence.calls.map((call) => <Link key={call.id} prefetch={false}
          href={`/dashboard/operations/${evidence.reference}/evidence?call=${call.id}`}
          aria-current={call.id === selected?.id ? "page" : undefined}>
          <span>{call.persona === "provider" ? "Proveedor" : "Cliente"} · {call.direction === "outbound" ? "Saliente" : "Entrante"}</span>
          <strong>{call.counterpartyName}</strong><time dateTime={call.startedAt}>{timestamp(call.startedAt, true)}</time>
          <small>{call.endedAt ? formatStatus(call.outcome) : "En curso"}</small>
        </Link>)}
      </nav>
      {evidence.calls.length === 0 && <p>No hay llamadas registradas.</p>}

    </aside>
    <section className="call-evidence-conversation" aria-label="Transcript y eventos">
      <header className="call-evidence-conversation-header">
        <div><p>TRANSCRIPT COMPLETO</p><h2>{selected?.counterpartyName ?? "Sin llamadas"}</h2>
          {selected && <span>{timestamp(selected.startedAt, true)} · {evidence.segments.length} fragmentos</span>}</div>
        <form method="get">
          {selected && <input type="hidden" name="call" value={selected.id} />}
          <button className="call-evidence-button" type="submit">Actualizar</button>
        </form>
      </header>
      <p className="call-evidence-explainer">El transcript está a la izquierda; los eventos, a la derecha. Se alinean por cercanía temporal
        dentro de la misma llamada (hasta {evidence.matchWindowSeconds} s). Los tiempos del transcript son relativos al inicio de la llamada; los eventos muestran la hora de registro (UTC−3). La cercanía no demuestra aceptación.
        Los eventos sin llamada asociada se identifican como eventos de la operación.</p>
      <div className="call-evidence-columns" aria-hidden="true"><span>Conversación</span><span>Eventos</span></div>
      {evidence.segments.length === 0 && <p className="call-evidence-empty">No hay fragmentos del transcript guardados para esta llamada todavía.</p>}
      <ol className="call-evidence-timeline">
        {timeline.map((item, index) => <li key={`${item.kind}-${item.id}`}>
          {(index === 0 || day(item.at) !== day(timeline[index - 1].at)) &&
            <p className="call-evidence-day">{day(item.at)}</p>}
          <div className="call-evidence-row">
            <div className="call-evidence-statement">
              <time dateTime={item.at} title={timestamp(item.at, true)}>{item.kind === "segment" ? elapsed(item.at, selected?.startedAt) : timestamp(item.at)}</time>
              {item.kind === "segment" && <div className={item.segment.speaker === "tango" ? "is-tango" : "is-caller"}>
                <strong>{item.segment.speaker === "tango" ? "Tango" : selected?.counterpartyName ?? "Interlocutor"}</strong>
                {item.segment.content === null ? <p className="call-evidence-redacted">Texto eliminado por retención. Se conserva el horario.</p>
                  : <p>{item.segment.content}</p>}
              </div>}
            </div>
            <div className="call-evidence-annotations">
              {item.kind === "event" ? <EventCard event={item.event} />
                : (grouped.get(item.id) ?? []).map((event) => <EventCard key={event.id} event={event} />)}
            </div>
          </div>
        </li>)}
      </ol>
    </section>
  </div>;
}
