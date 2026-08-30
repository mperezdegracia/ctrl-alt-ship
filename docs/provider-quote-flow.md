# Cotización outbound del Proveedor

Estado: implementación local; no aplicada ni desplegada.

## Alcance

Las Cotizaciones de Proveedor ocurren únicamente en llamadas outbound iniciadas por Tango. Una llamada inbound, incluso si responde a una llamada previa de Tango, no habilita cotización.

La dirección, propósito, Operación, Pedido de cotización, ronda, Mandato y Proveedor provienen de la correlación persistida. El runtime rechaza una llamada si falta la request exacta, el Mandato requiere confirmación, la request venció o la ronda no corresponde al propósito (`initial`, `renegotiation` o `replacement`).

La Factory construye `ProviderQuoteService` solo para `provider/outbound`. El estado outbound contiene exclusivamente la Operación/request seleccionada, términos verificados, negociación propia, `lastQuote` y `lastOffer`; no incluye Bookings, otras requests, competidores ni transcript inbound.

## Secuencia conversacional

Ante un importe o rango claro del Proveedor, Tango ejecuta inmediatamente `record_provider_offer` antes de contraofertar. Esa tool registra una observación histórica (`quote.offered`) y no aprueba, adjudica ni crea una Cotización formal. Cada nueva propuesta genera un hecho; repetir el mismo tool call es idempotente.

Después continúa la política comercial existente. Solo tras la aprobación verbal explícita del precio final se ejecuta `create_quote`; la Cotización formal es inmutable y conserva su evento `quote.received`, aun cuando quede fuera del Mandato. Una oferta observada nunca se presenta como aprobación ni Booking.

`decline_quote_request` registra el rechazo comercial definitivo. Los límites privados del Cliente solo están disponibles para el razonamiento interno del agente; nunca aparecen en resultados, logs o conversación.

## Estado, tools y sesión

La sesión carga el estado antes de aceptar la llamada. La lista de tools y las instrucciones se derivan del perfil actual. Después de cada escritura se refresca el estado, se reconstruyen la lista y el prompt y se llama a `updateAgent` sobre la misma sesión; no se crea otra sesión ni se reabre una request distinta.

Los perfiles `provider_quote`, `provider_unavailable` y `terminal` son excluyentes. `terminal` no ofrece nuevas tools. Fallos de refresh/configuración no dejan permisos viejos activos.

## Replacement y retries

Una cancelación inbound inicia una ronda de replacement separada, con requests y reloj propios. No se readjudica una Cotización histórica ni se reutiliza disponibilidad anterior. La ronda se cierra con adjudicación normal o `needs_follow_up` cuando se agotan candidatos y trabajo pendiente.

Los contactos outbound usan Outbox e intentos durables. Solo `no-answer` permite hasta dos reintentos adicionales, separados por el intervalo persistido; busy, failed, canceled, completed, rechazo verbal y errores de dispatch no generan otra llamada.

No se prometen Bookings, selección, entrega de email, emails de cancelación/reprogramación ni evidencia conversacional completa desde una Cotización.

No se ejecutaron pruebas, llamadas, migraciones ni despliegues como parte de esta documentación.
