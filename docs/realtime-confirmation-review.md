# Diagnóstico de tools y revisión de confirmación de voz

## Registro de sesión

Disponible con `LOG_LEVEL=info`, sin habilitar logs de transcripciones:

- `server.started`: bandera efectiva de tools de cliente y `deploy_commit` de Render.
- `realtime.session_update_requested`: perfil, OP, campos faltantes, nombres de tools,
  hash SHA-256 de instrucciones, secuencia y `update_event_id` generado por el backend.
  Describe un envío solicitado, no una aplicación confirmada por OpenAI.
- `realtime.session_updated` / `realtime.session_created`: `received_tools` tomadas
  del evento real del SDK, `expected_tools`, `tools_match` e `instructions_match`.
  Las instrucciones se comparan por hash; no se escriben en estos logs.
- `realtime.session_configuration_mismatch`: advertencia si la configuración
  observada no coincide con la última solicitada. No modifica ni bloquea la sesión.
  `session.updated` no devuelve el ID del evento cliente: no se asume un emparejamiento
  exacto. Una respuesta atrasada puede describir una configuración anterior.
  Campos ausentes se informan como desconocidos (`null`), no como listas vacías.
- `tool.requested`: perfil, tools anunciadas por el backend y últimas tools
  observadas en la sesión. No añade argumentos ni transcripciones al nivel info.
- `confirmation.evidence_checked`: disponibilidad, motivo técnico, fin de respuesta,
  señal de buffer de salida drenado y presencia de transcripción; nunca el texto.

Para el caso de Lucas, después de completar los datos, se espera:

1. `realtime.session_update_requested`: `profile: client_confirm`, tools
   `update_operation` y `confirm_mandate`.
2. `realtime.session_updated`: `received_tools` con ambos nombres y coincidencias
   verdaderas. Si faltan, revisar la configuración enviada/recibida y errores de API.
3. Si están presentes pero no hay `tool.requested` para `confirm_mandate`, revisar
   el turno conversacional y el prompt; todavía no se ejecutó el handler.
4. Si existe el intento, revisar `confirmation.evidence_checked` y `tool.failed`.
   `available: false` describe la evidencia local; un replay SQL puede recuperar un
   comando ya confirmado aunque esa evidencia ya no esté en memoria.

Estos logs son diagnóstico, no una corrección confirmada de la causa observada.

## SDK, approvals y evidencia

- El proyecto usa el paquete `openai` y `OpenAIRealtimeWS`, no
  `@openai/agents/realtime`. La clase `RealtimeSessionFactory` del proyecto solo
  construye configuración; no es la `RealtimeSession` del Agents SDK.
- OpenAI documenta `RealtimeAgent`/`RealtimeSession` en el
  [Agents SDK de voz](https://developers.openai.com/api/docs/guides/voice-agents).
  Adoptarlo sería una migración del runtime, no agregar una propiedad al schema actual.
- `needsApproval: true` pertenece al mecanismo de tools del Agents SDK. La
  [documentación de HITL](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)
  describe pausar, aprobar/rechazar y reanudar. No transforma una transcripción
  automáticamente en aprobación. Las APIs exactas de aprobación/audio del transporte
  Realtime/SIP se deben verificar en la versión del Agents SDK elegida antes de migrar;
  los ejemplos de `run` no prueban esa integración.
- La [API Realtime distingue functions y MCP](https://developers.openai.com/api/docs/guides/realtime-mcp):
  nuestras functions se ejecutan en el backend. La aprobación MCP nativa es otro
  mecanismo; no debe confundirse con `needsApproval` ni trasladarse a nuestras tools.
- El tracker actual espera `response.done` completado y `output_audio_buffer.stopped`
  de la misma respuesta, antes del siguiente turno del usuario. La señal indica
  drenaje del buffer de salida del servidor; no prueba audición humana, comprensión
  o consentimiento. No se afirma validez legal ni se equipara a grabación Twilio.
- La propuesta de estados conceptuales es útil, pero el adaptador debe conservar
  IDs de respuesta/item, interrupciones, transcripción asíncrona y estado por llamada.
  Un `markAudioEnded()` sin correlación podría habilitar una propuesta por el fin
  de otro audio. No se eliminan esas verificaciones para simplificar nombres.
- El flujo deseable sigue siendo propuesta exacta → respuesta de voz → evidencia
  candidata → validación del backend → commit transaccional. La semántica de la
  aprobación sigue a cargo del agente actual; no existe un evaluador independiente.
  La base verifica autorización, revisión de operación, estado, términos e idempotencia.
  IDs internos y evidencia se inyectan desde el servidor, nunca desde argumentos
  como `operationId`, `confirmationResponseId` o `callerTurnId` elegidos por el modelo.

Decisión de este cambio: instrumentar primero y mantener las verificaciones
existentes. No migrar de SDK ni cambiar el mecanismo de autorización al mismo
tiempo que se diagnostica la ausencia de `confirm_mandate`.
