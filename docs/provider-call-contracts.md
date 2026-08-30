# Contratos congelados P0 — 2026-08-30

Fuentes: super-backlog revisión 2, ADR 0003 y PLAN §§4–12. Sin ejecución de pruebas.

## Tipos y autoridad

- `backend/src/domain/call-flow.ts`: único ToolCallScope; operation-read-service
  lo reexporta por compatibilidad. Direction/purpose obligatorios.
- `backend/src/domain/provider-call-state.ts`: tipos de estado, Operation,
  Booking, targets, selección, oferta y resultados. Servicios viejos reexportan
  estos tipos, sin declarar copias incompatibles. No cambios a los contratos de Cliente.
- `backend/src/domain/provider-contact-contract.ts`: DTOs exactos RPC v2 escalares.
- `get_provider_tool_state` devuelve exactamente una rama con `flow` discriminado;
  JSON keys camelCase de ProviderInboundState/ProviderOutboundState. Entrada tiene
  bookings; después selección bookings=[] y selectedBooking. Targets nunca al modelo.
- Target Booking `{booking_id,operation_revision,mandate_id}`: booking_id debe ser
  igual al current_booking_id bajo lock. No booking_revision basado en updated_at.
- Target Quote agrega round_id a la revisión/request/Mandato/previous_quote_id.

## Firmas de voz

```text
get_provider_tool_state(p_call_id uuid,p_realtime_call_id text,p_provider_id uuid) -> jsonb
select_provider_booking(p_call_id uuid,p_realtime_call_id text,p_provider_id uuid,
  p_tool_call_id text,p_tool_name text,p_arguments jsonb) -> jsonb
record_provider_offer(p_call_id uuid,p_realtime_call_id text,p_provider_id uuid,
  p_tool_call_id text,p_arguments jsonb) -> jsonb
execute_provider_booking_tool(p_call_id uuid,p_realtime_call_id text,p_provider_id uuid,
  p_tool_call_id text,p_tool_name text,p_arguments jsonb,p_context jsonb) -> jsonb
execute_provider_quote_tool(p_call_id uuid,p_realtime_call_id text,p_provider_id uuid,
  p_tool_call_id text,p_tool_name text,p_arguments jsonb,p_context jsonb) -> jsonb
```

Selección solo recibe operation_reference. Mutaciones mantienen argumentos existentes;
oferta recibe price_range y currency opcional. Oferta devuelve `{status:recorded}`;
selección devuelve `{status:selected,operation_reference,intent}`. `commitment_created:false`
se conserva deprecated en resultados existentes para no romper consumidores; nunca true.
Los IDs anterior/nuevo/vigente pertenecen a eventos/estado privado, no al resultado hablado.
`booking.rescheduled` v2 usa payload v1 más `previous_booking_id`; booking_id es el sucesor.
`quote.received` v2 usa payload v1 más `offer_event_id`. No alterar eventos v1 históricos.

## Locks, routing y compatibilidad

- Orden: operación → llamada (si corresponde) → ronda → request → booking; primero
  localizar IDs sin lock y revalidar relaciones bajo lock. Locks Outbox/slot se
  adquieren consistentemente dentro del camino worker sin invertir el de Operación.
- calls.operation_id puede ser NULL antes de selección. Mantener la excepción
  de call.routed sin Operación en events: el 200000 la retiró y M1 debe restaurarla
  sin commitment_id. No inventar Operación al autenticar inbound.
- Nuevas calls provider tienen purpose; outbound requiere quote_request_id y attempt.
  No habilitar dispatch de historia sin correlación inequívoca.
- `/calls/outbound` requiere operación/provider/purpose/request/ronda existentes;
  solo informa/acepta trabajo ya encolado, sin INSERT de calls ni POST Twilio propio.
  Rechaza solicitud sin esa correlación. Único dispatch: worker con begin=true.
- Todos los nombres de error de domain/tool-error.ts se conservan. Identidad/familia
  incorrecta: not_authorized; target no disponible: operation_not_available;
  etapa: invalid_transition; referencia/acción distinta: intent_locked;
  revisión/puntero distinto: stale_operation; replay distinto: idempotency_conflict.
- Toda RPC nueva service_role. Dirección/familia se autentican antes del recibo.
- MB adapta SQL al Booking inmutable, incluidos triggers email: INSERT de
  reprogramación no envía emails. Las columnas legacy pueden seguir, no su autoridad.
- Para evidence ordering usar orden estable de segmentos existente, no comparar UUIDs.
  Sin captura suficiente, NULL; no reparar evidencia tras INSERT de Booking inmutable.

## Worker

Firmas/parametros de PLAN §10 y tipos del archivo compartido sin cambios. `attempt`
en DTO es outbound_attempt en calls; retornos jsonb escalares, no arrays.
Claim crea/enlaza calls.id; solo begin CAS habilita POST. Callback firmado exige
call_record_id, SID, AccountSid esperado, SequenceNumber y timestamp válido.
Callback status no confunde outcome comercial. Definitive/ambiguous son errores
de dispatch, nunca no-answer; retry del POST está prohibido. SID persistido puede
reintentarse sin repetir la llamada. NULL claim y no current round son casos válidos.
