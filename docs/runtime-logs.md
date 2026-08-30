# Logs de llamadas y operaciones

Los hitos nuevos salen en JSON por stdout con `LOG_LEVEL=info` (el default).
No hace falta activar debug ni agregar flags. Render los muestra en los logs del
servicio. Buscar por `call_id` (OpenAI), `call_record_id` (Postgres),
`twilio_call_sid`, `operation_id`, `quote_request_id` o `tool_call_id`.

El audio de entrada usa `noise_reduction: { type: "far_field" }` para clientes y
proveedores, en inbound/outbound, desde la aceptación SIP y durante los cambios
de tools. No requiere variables de entorno. `realtime.session_created/updated`
registra `received_noise_reduction_type` para ver la configuración devuelta por
OpenAI (null significa ausente o desactivada). No cambia la voz ni el VAD actual.
La reducción de ruido se aplica antes del VAD/modelo; su mejora acústica debe
validarse con una llamada real, no con los harnesses de configuración.
Referencia: [OpenAI, configuración de audio](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/accept).

- `call.routing_started/routed/routing_persisted`: dirección, tiempo e IDs.
- `call.accept_requested/accept_completed` y `realtime.sideband_connect_requested`:
  aceptación SIP y conexión del agente.
- `tool.execution_started/succeeded/failed`: nombre, campos enviados (no valores)
  y duración. `tool.state_refreshed`: perfil anterior/actual, campos faltantes,
  versión del mandato, confirmación pendiente, tools habilitadas y rondas restantes.
- `sourcing.contact_claimed/call_record_created/dial_requested/dial_accepted`:
  recorrido desde outbox hasta aceptación de la solicitud por Twilio. No prueba respuesta.
- `sourcing.decision`: motivo de espera o booking seleccionado. Se registra al
  cambiar o cada minuto; `sourcing.worker_heartbeat` resume operaciones activas.
- `twilio.call_status_received/recording_status_received`: callback recibido y
  validado, **no prueba de persistencia**. `twilio.callback_rejected`: firma/configuración.
- `email.delivery_started/delivered/delivery_failed`: modo preview/resend, intentos,
  IDs y duración, sin direcciones ni cuerpo del mensaje en estos hitos nuevos.
- `audio.speech_started/stopped`, `transcript.*_completed`,
  `realtime.response_started/completed`: turnos y cantidad de caracteres, no texto.

## Transferencia humana

Destino del demo: Theo, sufijo `5829`, fijo en código. Solo el proveedor tiene
`escalate`. Secuencia esperada: `escalation.prepare_started` → `prepared` →
`farewell_requested` → `farewell_started` → `refer_requested` → `refer_accepted`.
Se mantiene `refer_succeeded` por compatibilidad, ahora con
`human_answer_confirmed: false`. Un `200` indica aceptación del REFER, **no que
Theo atendió**. `response_after_refer` detecta actividad posterior del agente.
Referencia: [OpenAI, transferencia SIP](https://developers.openai.com/api/docs/guides/realtime-sip).

Limitaciones actuales revisadas, sin cambiar la lógica: el puente mock devuelve
`supervisor_notified: true` al preparar, pero no envía contexto al humano; no hay
confirmación de respuesta del humano, recuperación automática si no atiende ni
fallback si la despedida se interrumpe y no llega el evento de fin esperado.
Validar una transferencia real requiere una llamada consentida y correlación con
Twilio; los harnesses no la realizan.

Los nuevos hitos no agregan bodies, headers, credenciales, teléfonos completos ni
transcripciones. Existen logs previos de resultados/errores de tools que pueden
contener datos de negocio; limitar el acceso y retención de los logs del servidor.
