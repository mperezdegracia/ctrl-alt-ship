# Tango: cambios de reservas del transportista

Implementación local, 2026-08-30. No aplicada a Supabase ni desplegada.

El merge incorpora también selección automática y emails de adjudicación. Ver
[provider-sourcing-merge-decisions.md](provider-sourcing-merge-decisions.md) para
las reglas y migraciones completas. La ausencia de emails de **cambios/cancelación**
se mantiene. La referencia posterior a creación automática pendiente describe
el tramo original, antes de esa integración.

## Alcance acordado

- `reschedule_booking` cambia **solo la ventana de retiro** de una reserva
  confirmada del proveedor autenticado. Conserva precio, pago, ruta, operación y
  mandato. Confirma verbalmente únicamente la diferencia entre ventana vieja y nueva.
- No pide confirmar la zona horaria ni la recita en el resumen. Usa internamente
  la localidad de retiro y el contexto verificado; los timestamps siguen exigiendo
  offset. Si falta la localidad, aclara el lugar, no una zona técnica.
- Dentro de las ventanas autorizadas y con mandato vigente: registra la solicitud,
  aplica el cambio y emite `booking.rescheduled` en una transacción.
- Fuera del mandato o con condiciones desactualizadas: registra una solicitud para
  revisión, **no cambia la reserva** y deja disponible solo `escalate`. Guardar la
  solicitud no demuestra que hubo handoff; eso requiere ejecutar la escalación.
- Cambiar precio, ruta, equipo o pago requiere revisión humana. No se disfraza como
  reprogramación ni se vuelve a cotizar una reserva confirmada mediante esta tool.
- `cancel_booking` cancela únicamente la reserva confirmada de ese transportista,
  conserva historia y devuelve la operación a `sourcing`. No cancela el pedido del
  cliente, crea un mandato ni contacta automáticamente a un reemplazo.
- No se envían ni encolan emails. No se anuncia que el cliente fue notificado.
- Consentimiento conversacional: resumen, pregunta y siguiente turno explícito del
  usuario. Sin `needsApproval` ni tracker de audio. El backend valida autorización,
  estado y datos, pero no prueba que un humano escuchó o aceptó la propuesta.
- Auditoría mediante `change_requests`, eventos y recibos idempotentes. Se devuelve
  `commitment_created: false`: no se fabrican grabaciones ni filas `commitments`.

## Integración y controles

Las clases de tools delegan a `ProviderBookingService` y
`SupabaseProviderBookingRepository`. `get_provider_tool_state` combina cotizaciones
y reservas propias para construir el perfil dinámico. En entrada aparecen solo
los caminos con candidatos; una llamada ligada a un camino no ofrece los otros.
Un éxito termina las mutaciones de esa llamada. Una reprogramación para revisión
retira ambas tools de cambios. Reconectar conserva el estado persistido.

La RPC verifica llamada activa, proveedor activo y propiedad de la reserva por su
cotización real: haber cotizado la misma operación no permite cancelar la reserva
de otro transportista. Bloquea llamada, operación y booking; compara revisión de
operación, booking y mandato con el contexto privado obtenido por el servidor.
El modelo recibe referencias OP, nunca controla IDs o revisiones.

Mismo call/tool ID y argumentos devuelve el resultado guardado; argumentos distintos
fallan. El replay se permite después de terminar el flujo, previa autorización.
Un error de revisión exige refrescar y confirmar nuevamente el cambio.

La migración incorpora `previous_pickup_window` en solicitudes y
`last_change_request_id` en reservas. El trigger exige una solicitud aplicada,
coincidente y vigente para cambiar únicamente la ventana de una reserva confirmada.
No relaja los requisitos para crear reservas. Una reserva puede sobrevivir a la
vigencia original de su quote; eso no invalida por sí solo una reprogramación.

## Despliegue y pruebas

1. Aplicar las migraciones anteriores, luego
   `20260830070000_provider_quote_tools.sql` y
   `20260830080000_provider_booking_changes.sql`, en ese orden.
2. Desplegar el backend. Las tools del proveedor no requieren variable de entorno.
   Si falta la RPC de estado, falla la carga de la llamada; no se habilitan escrituras.
3. Preparar una **reserva confirmada propia** de prueba con retiro futuro y mandato
   vigente. Una quote aceptada no basta: la creación/selección de bookings sigue
   pendiente en el flujo automático. No se alteró el seed ni la base compartida.
4. Llamar como ese proveedor: «Quiero mover el retiro de la OP-… a …». Verificar que
   resume solo el cambio y espera confirmación. Corregirlo antes del sí no debe
   aplicar nada. Después del éxito, precio y condiciones deben seguir iguales.
5. En otro caso, proponer una ventana fuera de lo autorizado: la reserva no cambia,
   queda solicitud para revisión y Tango ofrece handoff sin anunciar aprobación.
6. Con otra reserva, pedir cancelación: confirmar OP y motivo. Verificar booking
   cancelado, operación en sourcing y ningún correo. Otro proveedor no puede hacerlo.

`npm --prefix backend run harness:tools:bookings` cubre contratos, validación,
contexto privado, errores, perfiles y round trips reales del Agents SDK con
transporte/RPC simulados. Las comprobaciones SQL son estáticas: **no prueban
ejecución PostgreSQL, atomicidad, concurrencia ni consentimiento humano**.
No se hicieron llamadas reales ni escrituras en Supabase.
