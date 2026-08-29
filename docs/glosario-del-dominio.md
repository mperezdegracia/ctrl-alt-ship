# Glosario del dominio

Este glosario es la traducción operativa del pizarrón; no son instrucciones del
brief de la hackathon.

| Término | Definición / datos mínimos |
| --- | --- |
| **Operación** | Solicitud de transporte end-to-end identificada por `operation_id`. Tiene origen, destino, carga, fecha, cliente, estado y el presupuesto elegido. |
| **Cliente** | Quien inicia la solicitud. Contacto: nombre, teléfono y email de confirmación. |
| **Mandato** | Autorización que el cliente da por voz en la llamada inicial para que el agente negocie y cierre solo. Mínimo: tope de precio (con moneda) y ventana de retiro; opcionalmente condiciones de la carga. Se confirma verbalmente, se persiste con la operación y **el servidor** valida toda selección, booking o renegociación contra él — el modelo nunca es la autoridad. Lo que excede el mandato se rechaza o escala, nunca se compromete. |
| **Proveedor** | Transportista/fletero que puede cotizar y aceptar una reserva. Tiene contacto, teléfono, email y capacidades. |
| **Pedido de cotización** | Trabajo idempotente que pide a un proveedor una oferta para una operación. Tiene intento, estado y vencimiento. |
| **Cotización** | Oferta estructurada: proveedor, precio, moneda, vigencia, disponibilidad, condiciones y eventual ETA. Nunca equivale a reserva. |
| **Booking / reserva** | Compromiso con una cotización seleccionada. Tiene una confirmación explícita del proveedor y un identificador de reserva. |
| **Llamada** | Interacción de telefonía, correlacionada con la operación y su proveedor/cliente. Guarda `twilio_call_sid`, `realtime_call_id`, rol y resultado. |
| **Evento** | Hecho inmutable de auditoría, por ejemplo `operation.created`, `quote.received`, `booking.confirmed` o `email.sent`. |
| **Outbox** | Registro transaccional de trabajo pendiente. Evita perder un contacto si el servidor cae después de guardar la operación. |

## Estados de una operación

```text
draft
  -> collecting_details
  -> sourcing
  -> quotes_received
  -> quote_selected
  -> booking_pending
  -> booking_confirmed
  -> notifications_sent

sourcing / booking_pending -> needs_follow_up | cancelled | failed
```

Para el demo, `quotes_received` puede comenzar cuando llega la primera oferta
válida. El sistema no debe requerir que respondan todos los proveedores para
seguir; usa un timeout declarativo.

## Datos que el agente de cliente debe confirmar

- Puerto/terminal de retiro y dirección de entrega (con localidad).
- Fecha o ventana de retiro, restricciones de turno y contacto en origen.
- Tipo de carga: contenedor/bultos, dimensiones, peso y necesidades especiales.
- El mandato: tope de precio y ventana de retiro, confirmados verbalmente.
  Carlos cierra todo en esa llamada; no hay aprobación posterior. El email
  final es confirmación de lo hecho, no un pedido de aprobación.

Si un dato crítico falta, el agente lo pregunta o deja la operación en
`collecting_details`; nunca inventa un valor.
