# Decisiones del merge — 2026-08-30

Decididas con Lucas, pregunta por pregunta, al integrar `7441019` con las tools
locales. Esta sección reemplaza las restricciones anteriores de sourcing y emails
para **adjudicación**; no habilita emails de cancelación/reprogramación.

- Contactar hasta **dos** transportistas activos distintos elegidos al azar,
  sin filtrar por equipo ni ordenar por nombre (decisión actualizada el 2026-08-30).
  La selección se persiste al crear el mandato; los reintentos llaman a los mismos.
  Si solo hay uno activo se contacta a uno; si no hay ninguno, no se encolan llamadas.
  Aplica a mandatos nuevos: no reenvía solicitudes de mandatos existentes.
  Este cambio es solo para elegir a quién llamar; no altera las validaciones de
  cotización/adjudicación, incluida la compatibilidad de equipo al adjudicar.
- Conservar la propuesta inicial y **tres contraofertas** locales por pedido,
  persistidas entre llamadas. No volver a una única contraoferta remota.
- Confirmar verbalmente la cotización completa autoriza la reserva si resulta
  elegida. Primero se comparan propuestas; no se pide otra aprobación después.
- Elegir cuando terminen todas las negociaciones o transcurran **cinco minutos
  desde el primer envío exitoso** a transportistas. `dispatched_at` registra que
  Twilio aceptó la llamada, no demuestra que alguien atendió. La espera en cola no
  consume esos cinco minutos, ni los reintentos reinician el reloj.
- Si no hay ninguna válida, seguir esperando. El plazo de comparación no expira
  los pedidos automáticos ni mueve la operación a `needs_follow_up`. La primera
  válida recibida después se adjudica. No reinicia rondas, no inventa aceptación
  ni vuelve a contactar automáticamente a quienes ya rechazaron definitivamente.
- Primero filtrar cumplimiento de mandato vigente, moneda, equipo, ventana,
  condiciones, pago y vigencia comercial. Entre las propuestas de la ventana
  inicial elegir menor `price_max`; empate: la recibida primero, luego UUID.
- Crear reserva confirmada y encolar un email para el **cliente** y otro para el
  **transportista elegido**. No requiere respuesta al correo ni otra llamada.
- No exponer cotizaciones ajenas al agente negociador. La comparación es SQL.
- No crear excerpts/checkpoints ficticios: se retiene quote/evento/call reales y
  se devuelve `commitment_created: false` donde corresponde.
- Reprogramación/cancelación conservan las reglas locales y no envían correos.

## Resolución técnica

Se conserva el worker remoto de sourcing, la infraestructura idempotente de emails
y las mejoras de handoff Twilio. Las tools locales `create_quote` y
`decline_quote_request` reemplazan `record_provider_quote`; se revoca esa RPC
legada a `service_role` para evitar el camino de una sola contraoferta. Nuevas
sesiones usan los perfiles persistidos y las tools de cambios de reservas.

La finalización observa `sourcing` y `quotes_received`, no termina anticipadamente
por una contraoferta con estado `responded` y vuelve a validar elegibilidad antes
de reservar. El bloqueo de operación serializa la adjudicación con las mutaciones
de tools. La cola de emails se activa por el trigger de reserva confirmada.
Los pedidos de un nuevo mandato se ligan explícitamente a ese mandato: el trigger
se ejecuta antes de que `operations.current_mandate_id` cambie.

## Migraciones y despliegue pendiente

El remoto contenía dos archivos con versión `20260830050000`. Se conserva sourcing
en esa versión y se renombra el archivo de emails a `20260830050001`.
El check de GitHub confirmó que esa migración fallaba por `outbox.locked_until`
ya existente. Se hizo repetible para reconciliar columnas/tablas/índices y
reemplazar las mismas funciones/triggers sin borrar datos. Las migraciones locales son:

1. `20260830070000_provider_quote_tools.sql`
2. `20260830080000_provider_booking_changes.sql`
3. `20260830090000_integrate_provider_sourcing.sql`

La integración GitHub aplica las migraciones desde `main`; no hay que usar el
editor SQL ni modificar manualmente su metadata. La migración de emails tolera
los objetos de su versión anterior. Se preservan recibos históricos de
`record_provider_quote`, sin reactivar esa tool. La migración adicional
`20260830100000_sourcing_dispatch_event.sql` registra el evento faltante que
revertía `confirm_mandate` y solicita recargar la caché de PostgREST.
Las pruebas locales son estáticas/simuladas; el check de Supabase valida el despliegue.

Aplicar el conjunto de migraciones antes de desplegar este backend. Reiniciar las
llamadas de prueba que todavía usen la antigua tool. Para enviar emails reales,
el entorno debe tener `EMAIL_DELIVERY_MODE=resend`, `RESEND_API_KEY`, `EMAIL_FROM`
válido y el worker habilitado. `preview`, el default seguro heredado del remoto,
solo guarda vistas previas; no afirmar entrega real. No se cambiaron secretos ni
configuración del entorno ni se enviaron correos o llamadas en estas pruebas.

Verificaciones: typecheck, harnesses de tools/SDK/handoff/email simulados y
`harness:sourcing` (regresiones estáticas de integración y versiones únicas).
