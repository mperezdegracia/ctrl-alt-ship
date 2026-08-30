# Flujos de llamadas salientes

Este documento concreta el alcance de la issue #8. La ruta elegida es SIP de
Twilio hacia OpenAI Realtime, igual que inbound; por eso no se crea ADR 0003,
que queda reservado para una desviación a Media Streams.

## Límites y seguridad

- Sólo dos flujos pueden originar llamadas: un Pedido de cotización nuevo y
  una Renegociación causada por incompatibilidad entre Mandato y Booking.
- El destinatario siempre es un Contacto o Proveedor activo y autorizado del
  ERP; no existe marcado a un número arbitrario.
- Las tools crean trabajo en el Outbox. El worker invoca el servicio de
  telefonía; `POST /calls/outbound` es su adaptador interno y de harness,
  protegido con un secreto de servicio. El dashboard no puede invocarlo.
- El worker inicia como máximo una llamada por segundo (CPS de Twilio) y como
  máximo tres llamadas activas por Operación. `queued`, `ringing` e
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

1. La tool del agente de Cliente crea Pedidos de cotización idempotentes para
   los Proveedores activos compatibles. Si aún no hay capacidades modeladas,
   el fallback es todos los Proveedores activos.
2. El worker contacta hasta tres en paralelo y cada conversación pide una
   Cotización para la misma Operación.
3. La recolección cierra cuando todos alcanzan un resultado terminal o al
   cumplirse cinco minutos. Una conversación ya conectada obtiene hasta dos
   minutos de gracia para concluir; el ciclo completo no supera siete minutos.
4. El servidor selecciona la Cotización vigente y dentro del Mandato con menor
   `price_max`. Si no hay ninguna, produce una Escalación.
5. La selección crea el Booking inmediatamente. Se encolan emails idempotentes
   al Cliente y al Proveedor elegido como notificación, no como aprobación.

`busy` y `no-answer` no se reintentan automáticamente en el MVP: el Pedido
queda pendiente hasta el deadline. Sólo las fallas técnicas anteriores a la
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
- Si un Cliente cancela, se cancela lógicamente la Operación y se notifica al
  Proveedor por email.
