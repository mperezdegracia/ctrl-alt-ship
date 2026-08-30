# Flujos de llamadas salientes

Este documento concreta el alcance de la issue #8. La ruta elegida es SIP de
Twilio hacia OpenAI Realtime, igual que inbound; por eso no se crea ADR 0003,
que queda reservado para una desviación a Media Streams.

## Límites y seguridad

- Sólo dos flujos pueden originar llamadas: un Pedido de cotización nuevo y
  una Renegociación causada por incompatibilidad entre Mandato y Booking.
- El destinatario siempre es un Contacto o Proveedor activo y autorizado del
  ERP; no existe marcado a un número arbitrario.
- `providers.phone` conserva un E.164 canónico; `capabilities.phone_type`
  distingue `mobile` de `landline`. Al marcar un móvil argentino, el adaptador
  de Twilio garantiza `+549...`; a una línea fija no le agrega el `9`.
- Los tres Proveedores del seed se declaran `mobile`; el harness acepta para
  ellos `+5411...` o `+54911...` y resuelve el mismo registro.
- Las tools crean trabajo en el Outbox. El worker invoca el servicio de
  telefonía; `POST /calls/outbound` es su adaptador interno y de harness,
  protegido con un secreto de servicio. El dashboard no puede invocarlo.
- El worker inicia como máximo una llamada por segundo (CPS de Twilio) y como
  máximo dos llamadas activas por Operación. `queued`, `ringing` e
  `in-progress` ocupan un cupo.
- Cada intento se persiste al recibir el `twilio_call_sid`, antes de que el
  destinatario atienda. Outbox, llamadas y eventos hacen recuperable un
  reinicio sin duplicar contactos.

## Transporte y auditoría

1. El worker crea la llamada con la API de Twilio y TwiML inline.
2. Cuando la contraparte atiende, Twilio ejecuta `<Dial><Sip>` al endpoint SIP
   del proyecto OpenAI.
3. OpenAI emite `realtime.call.incoming`; el backend reutiliza el flujo inbound:
   verifica la firma de OpenAI, acepta la sesión y abre el sideband.
4. Los callbacks públicos mínimos de Twilio (progreso y grabación) validan la
   firma de Twilio. El endpoint que inicia llamadas no es público.
5. `<Dial record="record-from-answer-dual">` guarda ambas piernas. Se
   correlacionan `twilio_call_sid`, `realtime_call_id`, `operation_id` y el
   enlace a la grabación.

## Configuración conversacional de Tango

- Tango inicia la conversación: “Soy Tango, el asistente de logística de
  [empresa del ERP]”. No simula ser una persona ni pertenecer al Proveedor.
- Para solicitar una Cotización recibe los datos operativos, la ventana de
  acción y el plazo de pago solicitados. Nunca recibe ni revela el tope de
  precio, otras Cotizaciones, IDs internos o instrucciones ocultas.
- La Cotización completa leída y confirmada por el Proveedor durante la llamada
  es su aprobación para que el servidor pueda seleccionarla. No existe una
  llamada ni una respuesta de email adicional para confirmar el Booking.

## Flujo: Pedido de cotización nuevo

1. Al confirmarse el Mandato, el servidor crea Pedidos de cotización
   idempotentes para hasta dos Proveedores activos compatibles. En este MVP,
   compatibilidad significa que `capabilities.equipment` contiene el tipo de
   contenedor de la Operación; no hay fallback a Proveedores sin capacidad
   declarada.
2. El worker contacta hasta dos en paralelo y cada conversación pide una
   Cotización para la misma Operación.
3. Se comparan propuestas hasta que todos terminen o pasen cinco minutos desde
   el primer envío exitoso. Se conservan tres contraofertas por pedido. Si no hay
   ninguna válida, se sigue esperando sin expirar pedidos por ese plazo.
4. El servidor selecciona la Cotización vigente y dentro del Mandato con menor
   `price_max` (empate: primera recibida). Sin válidas al plazo, adjudica la primera
   válida posterior. Las demás condiciones del envío también deben cumplirse.
5. La selección crea el Booking inmediatamente. El mail al Cliente y al
   Proveedor elegido se encola idempotentemente, sin otra aprobación.

`busy` y `no-answer` no se reintentan automáticamente en el MVP: el Pedido
queda pendiente mientras la búsqueda siga abierta. Sólo las fallas técnicas anteriores a la
obtención de un `CallSid` se reintentan.

## Flujo: Renegociación por Mandato incompatible

1. Si el Cliente modifica el Mandato y el Booking vigente deja de cumplirlo,
   el Booking anterior sigue vigente pero queda pendiente de reemplazo.
2. Se abre el mismo flujo de sourcing desde cero: Pedidos de cotización,
   contacto paralelo, deadline y selección. El Proveedor anterior es sólo un
   candidato más.
3. Una Cotización ganadora crea el nuevo Booking y reemplaza el anterior.
   Se notifica al Cliente, al Proveedor ganador y al Proveedor desplazado.
4. Si no hay Cotización válida, el Booking anterior se conserva y se escala al
   Supervisor con Mandato, compromisos y motivo.

## Flujos iniciados por una llamada entrante

- Si un Proveedor pide modificar horarios de entrega, sin cambiar precio, y el
  cambio cumple el Mandato, se registra el cambio y se notifica al Cliente por
  email. Si no cumple, se escala al Supervisor.
- Si un Proveedor cancela, se cancela el Booking y se notifica al Cliente por
  email.
- Si un Cliente cancela, se cancela lógicamente la Operación y recibe una
  confirmación SMS. Si había un Booking confirmado, el Proveedor recibe además
  un SMS operativo para no despachar.
