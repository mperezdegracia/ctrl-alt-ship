# Logs de runtime

Los hitos salen en JSON por stdout con `LOG_LEVEL=info` y pueden consultarse en
los logs del servicio. Correlacionar por `call_id`, `call_record_id`,
`twilio_call_sid`, `operation_id`, `round_id` o `quote_request_id`. Los logs nuevos
solo incluyen metadata operativa; no imprimen caps/precios privados, prompts,
transcripts, cuerpos de respuesta, teléfonos completos ni credenciales.

## Telefonía y dispatch

- `sourcing.worker_started`, `sourcing.worker_poll` y `sourcing.worker_heartbeat`:
  ciclo, iteración, cola, intervalo y cantidad de operaciones; no significan que
  haya una llamada iniciada.
- `sourcing.contact_claimed`: job durable, operación/ronda/request/proveedor,
  propósito y attempt; destino telefónico solo puede aparecer como sufijo si el
  logger existente lo requiere.
- `sourcing.contact_not_authorized_to_dial`: claim recuperado o rechazado por
  revalidación SQL; no hubo POST.
- `sourcing.provider_call_started`: Twilio devolvió un
  SID y el finish persistió el dispatch. Esto no prueba que el Proveedor atendió.
- `sourcing.provider_call_sid_persist_failed` y
  `sourcing.provider_call_sid_reconciliation_required`: el POST ya ocurrió pero
  la persistencia necesita reconciliación; nunca implican redial.
- `sourcing.contact_failure_recorded` y `sourcing.contact_failure_persist_failed`:
  error de dispatch y estado de persistencia, separados del resultado comercial.
- `sourcing.decision`: finalización o espera de revisión comercial; no equivale a
  una llamada atendida ni a un Booking creado.

## Callbacks

- `twilio.call_status_persisted`: la RPC devolvió tras validar firma, AccountSid,
  correlación, secuencia y timestamp. Incluye `accepted`, `retry_scheduled` y
  `next_attempt`; un callback duplicado puede tener `accepted=false`.
- `twilio.call_status_rejected`: rechazo del handler o error de persistencia;
  no prueba que la transacción no haya ocurrido si se perdió su respuesta.
- Status `initiated`, `ringing` o `in-progress` no se confunden con aceptación
  humana. `in-progress` y `completed` son evidencia de atención; `no-answer`,
  `busy`, `failed` y `canceled` son resultados telefónicos terminales.
- Un retry durable se registra por `no-answer` solamente, con attempt siguiente y
  disponibilidad futura. Nunca inferir `no-answer` desde timeout de POST, fin de
  SIP, `busy`, rechazo verbal o callback ambiguo.
- `twilio.recording_status_received` conserva la política existente de recording;
  estos logs no publican URLs de audio ni contenido.

## Voz, tools y operación

- `call.routing_started`, `call.routing_persisted`, `call.accept_requested` y
  `call.accept_completed`: dirección e IDs de correlación.
- `tool.execution_started/succeeded/failed`: nombre, duración y metadata de
  resultado; no argumentos sensibles ni payload completo.
- `tool.state_refreshed`: perfil, campos faltantes, versión del Mandato,
  confirmación pendiente y ronda; no targets privados.
- `audio.*`, `transcript.*` y `realtime.response_*`: evento y conteos, nunca texto
  del transcript en logs nuevos.
- `email.delivery_*`: modo, intento, IDs y duración; sin direcciones ni cuerpo.

La escalación conserva su destinatario configurable en Directory
(`handoff_recipients`); no hardcodear ni registrar el teléfono completo. Un REFER
aceptado no prueba que el Supervisor atendió. Los logs heredados pueden contener
datos de negocio: limitar acceso y retención según la política del entorno.

## Activación y límites

El runbook de activación es documental: pausar dispatch sin feature flag nuevo,
drenar llamadas antiguas, aplicar `M0 → MB → M1 → M2 → M3`, desplegar backend
compatible, retirar caminos legacy y reanudar. Ver [runbook](outbound-worker.md):
no hay pausa independiente del loop. `backend/render.yaml` declara autodeploy por
commit; el workflow de migraciones no aplica DB remota ni coordina atomicidad
con backend. No ejecutar estos pasos desde aquí.

Revisión de logs: estática solamente; no se ejecutaron tests, QA, llamadas,
migraciones ni despliegues.
