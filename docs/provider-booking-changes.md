# Cambios de Bookings del Proveedor

Estado: implementación local; no aplicada ni desplegada.

## Flujo inbound

Una llamada inbound del Proveedor gestiona exclusivamente sus Bookings confirmados. El estado autorizado proviene de `get_provider_tool_state` y lista solo Bookings cuyo `current_booking_id` apunta a una reserva vigente y cuya Cotización pertenece al Proveedor.

Al entrar, Tango ofrece listar y exige elegir explícitamente una acción y una referencia `OP-…` mediante `select_booking_for_reschedule` o `select_booking_for_cancellation`. La selección persiste `operation_id`, `selected_booking_id` e intención, pero no modifica el Booking. Después de seleccionar queda disponible únicamente la acción elegida; `escalate` aparece solo con Booking e intención seleccionados. Una llamada sin Bookings no expone selectores ni mutaciones.

## Mutaciones

`reschedule_booking` solo cambia fecha y horario de retiro, con confirmación verbal inmediata. SQL valida la ventana del Mandato. Si requiere revisión, la reserva permanece intacta y solo se registra la Solicitud de cambio.

`cancel_booking` cancela únicamente el Booking vigente del Proveedor. La Operación permanece abierta y vuelve a sourcing (o `needs_follow_up` si no hay candidatos autorizados); el Booking histórico no se actualiza ni se elimina. La cancelación y el trabajo de replacement forman una única transacción idempotente; un error revierte ambos.

La autoridad de vigencia es `operations.current_booking_id`, no el status histórico. Cada reprogramación autorizada inserta un Booking sucesor y mueve el puntero. Los resultados conservan `commitment_created: false` únicamente por compatibilidad deprecated; no existe entidad Compromiso operativa.

No se envían ni encolan emails por reprogramar o cancelar. Tampoco se promete evidencia completa de audio/transcript: el Booking solo puede referenciar evidencia real cuando exista.

## Runtime y seguridad

La Factory construye el servicio Booking solo para `provider/inbound`; el repositorio obtiene estado por la llamada persistida y falla cerrado si falta configuración. Tras una tool mutante se refresca el estado y se reconstruyen tools/instrucciones sobre la misma sesión Realtime.

SQL valida identidad, Proveedor activo, familia inbound, Booking seleccionado, puntero vigente, revisión e idempotencia. Un replay idéntico devuelve su recibo después de autenticar la llamada todavía activa; reutilizar la clave con otra acción o argumentos produce conflicto. Una revisión obsoleta exige refrescar y confirmar nuevamente.

La recuperación de replacement usa rondas y Outbox durables. Los reintentos telefónicos solo proceden ante `no-answer`, hasta tres intentos por Proveedor y búsqueda. Si no hay reemplazo válido ni trabajo pendiente, la Operación queda en `needs_follow_up`. No se anuncia que el reemplazo ya fue conseguido.

No se ejecutaron pruebas, llamadas, migraciones ni despliegues como parte de esta documentación.
