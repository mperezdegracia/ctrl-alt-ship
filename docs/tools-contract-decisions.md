# Decisiones del contrato de tools

**Estado:** acordado durante el grill de la issue #1

**Fecha:** 2026-08-29

**Actualización vigente (2026-08-30):** runtime Agents SDK, confirmación conversacional
sin tracker de audio ni `needsApproval`, y saludo inicial en inglés para ambas personas.
Ver [decisión, límites y despliegue](realtime-confirmation-review.md).

**Confirmación de modificaciones:** con un mandato previo se confirman solo las
diferencias; condiciones no modificadas se heredan en SQL, sin pedirlas ni leerlas
otra vez. confirm_mandate acepta un parche comercial ({} si nada comercial cambia).
El primer mandato sigue requiriendo todos los términos y resumen completo.
La nueva versión sigue siendo completa e inmutable y requiere renovar la aceptación
del transportista bajo las condiciones cambiadas.

## Seguridad y contexto

- El servidor autentica la contraparte por caller ID. El modelo decide la
  intención conversacional, no la identidad.
- UUIDs y contexto interno nunca son argumentos controlados por el modelo. El
  sideband resuelve llamada, contraparte, operación, mandato, pedido de
  cotización, booking y evidencia.
- Las referencias públicas `OP-000001` sirven para desambiguar operaciones y
  siempre se validan contra la contraparte autenticada.
- El UUID interno y la referencia `OP-…` tienen defaults generados por PostgreSQL.
  La creación normal omite ambos campos; el seed reserva una referencia fija de demo.
- El nombre visible se deriva de `pickup_location → delivery_location` y se expone
  como `operation_name` en los listados. Se presenta junto a la referencia; puede
  repetirse y no se usa para autorizar ni identificar unívocamente una operación.
  Si faltan ubicaciones, se muestra origen/destino pendiente, sin inventar datos.
  No se persiste otro campo: cambiar la ruta actualiza el nombre sin cambiar el OP.
- La disponibilidad de una tool orienta al modelo, pero no autoriza la acción:
  cada handler vuelve a validar persona, estado, propiedad e idempotencia.

## Inyección dinámica y bloqueo de camino

- Las tools se reemplazan durante la sesión mediante `session.update`.
- Cliente inbound y provider inbound pueden comenzar con intención `undecided`
  y sin operación. La primera mutación vincula una operación y bloquea el camino.
- Cliente: entrada con listar, crear, actualizar o cancelar. Después de elegir,
  desaparecen los caminos incompatibles.
- Provider outbound: el servidor conoce operación y objetivo, por lo que expone
  únicamente cotizar o rechazar el Pedido de cotización y `escalate`. La
  selección posterior del servidor crea el Booking sin una llamada adicional.
- Provider inbound: puede listar sus operaciones activas y elegir cotizar o
  rechazar el pedido, confirmar o rechazar un booking pendiente, reprogramar,
  cancelar booking o escalar. Después de elegir se bloquea el flujo.
- `escalate` queda disponible solamente para la persona provider en V1.
- La implementación se activa por tramos: crear/editar requiere la migración de
  tools de cliente y `CLIENT_OPERATION_TOOLS_ENABLED=true`. Las tools todavía sin
  handler no se exponen, aunque figuren en el perfil del contrato final.
- Un borrador creado con todos los campos operativos puede devolver directamente
  `next_profile: client_confirm`; uno incompleto devuelve `client_create`.
- Después de crear o seleccionar mediante una edición, ambos perfiles exponen
  `update_operation` y `confirm_mandate`. Que la tool esté visible no indica que
  los datos estén completos: el prompt exige completarlos y SQL lo verifica.
- Cada mutación de cliente recibe el ID de invocación de Realtime desde el sideband,
  nunca desde los argumentos del modelo. Su resultado se persiste junto a la mutación
  y los eventos para permitir reintentos idempotentes.

## Prompt y sesión Realtime

- El runtime usa `gpt-realtime-2.1` con `reasoning.effort: low` para equilibrar
  selección de tools y confirmaciones con latencia telefónica.
- La salida de audio usa la voz `cedar` a velocidad `1.05`. La voz se fija antes
  de producir el primer audio porque no puede cambiarse después dentro de la
  misma sesión.
- El agente saluda primero en inglés, tanto a clientes como a proveedores.
  Después responde en el idioma dominante de cada intervención sustantiva del
  usuario y cambia automáticamente en el siguiente turno; no espera un pedido
  explícito. Nombres, direcciones, acentos o palabras aisladas no disparan
  cambios una vez establecido el idioma.
- Las instrucciones se componen con una base compartida, reglas polimórficas de
  cliente/provider y contexto verificado al final. Teléfono, email, SIP, UUIDs,
  transcript y errores internos no se inyectan al prompt.
- Resultados actuales de tools prevalecen sobre el snapshot inicial. El agente
  no anuncia éxito hasta recibir el resultado del handler.
- La implementación separa responsabilidades en clases: builder de instrucciones
  por persona, factory de sesión Realtime y registry de tools. Cada tool concreta
  encapsula su schema y ejecución.

## Operación y mandato

- `operations` es la proyección mutable actual. Restricciones operativas y notas
  de carga forman parte de sus términos.
- La ventana pedida por el cliente y la autorización temporal son una sola lista
  `action_windows`. La propuesta del provider debe quedar enteramente dentro de
  una de ellas.
- `confirm_mandate` aparece cuando la operación está completa, pero sólo se llama
  después de un resumen verbal y una confirmación inequívoca del cliente.
- Cada confirmación crea un mandato inmutable nuevo con snapshot construido por
  el servidor. Transcript, timestamp y checkpoint tampoco los aporta el modelo.
- La confirmación cierra las tools de cliente para esa llamada, sin cortar el audio.
  Un reintento conserva el resultado original; otra confirmación requiere otra llamada.
- Una revisión de operación distinta de la resumida obliga a repetir el resumen y
  confirmar de nuevo. No se usan snapshots o revisiones aportados por el modelo.
- La evidencia del mandato guarda resumen reproducido y siguiente intervención,
  correlacionados por eventos de Realtime. Interpretar la aprobación sigue siendo
  responsabilidad conversacional del agente, no de una regex de palabras afirmativas.
  Si falta evidencia o el resumen fue interrumpido, no se confirma.
- El offset `input_audio_end_ms` se identifica como audio Realtime y no se presenta
  como checkpoint de una grabación Twilio sin correlación. Esta integración queda pendiente.
- Cambiar cualquier término operativo activa
  `mandate_confirmation_required`. Hasta una nueva confirmación se bloquean
  sourcing, contacto con providers y cambios de booking.
- Los importes viajan como números JSON por simplicidad y se convierten a
  `numeric` en el servidor.

## Cancelaciones del cliente

- `cancel_operation` es cancelación lógica, nunca `DELETE`.
- Requiere confirmación verbal explícita y termina el flujo de tools.
- No crea ni reemplaza un mandato; conserva las versiones y compromisos históricos.
- Decisión vigente (2026-08-30): no enviar ni encolar emails. Se encola una
  confirmación SMS idempotente al cliente; si existe un Booking confirmado, se
  encola también un aviso operativo SMS al provider. `client_sms_queued` y
  `provider_sms_queued` expresan que existe el job durable, no una entrega ni
  aceptación del provider.
- No requiere confirmación telefónica del provider. Un Booking pending no
  recibe aviso de cancelación.
- Detalle de implementación y límites: [client-cancellation.md](client-cancellation.md).

## Cotización y negociación

- `create_quote` recibe rango mínimo/máximo, moneda, ventana, plazo de pago,
  vigencia y condiciones. No recibe IDs internos.
- El servidor evalúa `price_max` contra el mandato y selecciona por el menor
  `price_max` válido: el menor peor caso.
- Decisión vigente: varias rondas, por defecto **tres contraofertas por pedido**,
  además de la propuesta inicial. `quote_requests.negotiation_limit` es un límite
  del servidor (1–10), no un argumento del modelo. El contador se deriva de las
  versiones guardadas y no se reinicia al cambiar de llamada.
- Si solo falla el precio, devuelve `contraoferta` mientras quede presupuesto,
  incluso si el mínimo supera el tope. La última propuesta aún fuera devuelve
  `fuera`. Cada revisión exige resumen y confirmación verbal nuevamente.
- Tango pregunta por disponibilidad, inclusiones y qué explica el precio; pide
  una mejora con calma, no inventa una contraoferta numérica ni promete concesiones.
- Por ahora **no se consultan ni usan quotes de otros transportistas**. Se retiró
  esa posibilidad por pedido del usuario. El prompt identifica al agente como Tango.
- El precio máximo del cliente nunca aparece en respuestas a tools de provider.
- Errores estructurales y conflictos con términos fijos no consumen la ronda.
- Las negativas explícitas se guardan como estado y evento, sin crear quote ni
  compromiso.
- Primer tramo implementado: [provider-quote-flow.md](provider-quote-flow.md).
  La tool guarda cotización/veredicto; el worker integrado compara y adjudica,
  encolando emails solo al crear la reserva. No inventa evidencia de audio.
  Decisiones vigentes: [provider-sourcing-merge-decisions.md](provider-sourcing-merge-decisions.md).

## Booking, cambios y escalación

- `select_quote` crea el Booking al seleccionar la Cotización vigente válida
  con menor `price_max`; la Cotización completa ya fue confirmada verbalmente
  por el Proveedor. Los emails posteriores son notificaciones, no aprobación.
- `reschedule_booking` sólo cambia la ventana y conserva precio y condiciones.
  Fuera de `action_windows` no aplica nada y requiere escalación.
- Si el provider exige otro precio, no se modela como reprogramación. En el tramo
  actual se ofrece revisión humana; no se recotiza una reserva ya confirmada.
- `cancel_booking` representa que el provider abandona el compromiso: crea el
  rastro de cancelación y devuelve la operación a sourcing. Por decisión vigente,
  **no avisa al cliente ni encola correo**. No cancela la operación del cliente.
- Tramo local 2026-08-30: reprogramación y cancelación guardan `change_requests`,
  eventos y recibos, sin `commitments` ficticios (`commitment_created: false`).
  Consentimiento conversacional solo del cambio mínimo; sin tracker ni approvals.
  Ver [provider-booking-changes.md](provider-booking-changes.md).
- Una negativa de booking o reprogramación conserva evidencia pero no crea un
  compromiso aceptado.
- `escalate` entrega al supervisor compromisos, mandato y motivo. Nunca envía el
  transcript crudo ni revela el tope.

## Actualización 2026-08-30: alta y mandato con una sola aprobación

- Para crear o modificar, el cliente conversa sobre un único pedido y sus
  condiciones. No se piden aprobaciones separadas para guardar campos, crear
  mandato y comenzar la búsqueda de transportistas.
- Reutilizar lo ya dicho, preguntar solo lo faltante en grupos cortos y guardar
  todos los campos de envío suministrados juntos. No inventar datos obligatorios.
- Antes del mandato, guardar los datos del pedido y dar un resumen combinado
  breve: envío/ruta, máximo y moneda, fechas/horarios, pago y restricciones relevantes.
  Una sola aprobación posterior autoriza confirmar el mandato y contactar carriers.
- Una corrección requiere confirmar el cambio, no recitar toda la operación otra
  vez. Un cambio concurrente o fallo no permite anunciar éxito ni usar consentimiento
  obsoleto. Las condiciones comerciales no se guardan como notas de carga.
- Al aprobar, ejecutar `confirm_mandate` inmediatamente y cerrar brevemente tras
  éxito. Las tools siguen siendo separadas internamente; no se cambió el schema,
  la validación de campos ni la autorización en Postgres. Cancelación y proveedor
  conservan sus reglas específicas.
- Se alinearon el prompt de entrada, los perfiles posteriores y la descripción
  de la tool para evitar volver a pedir aprobación tras un cambio de perfil.
  Guía consultada: [OpenAI, prompting Realtime](https://developers.openai.com/api/docs/guides/realtime-models-prompting).
- Sin ejecución de tests por indicación del usuario; mejora conversacional todavía
  pendiente de validar en una llamada real. No se promete reducción de latencia de red.

## Cotización mínima y contraofertas solo de precio (vigente)

- Actualización cliente: crear/editar exponen solo origen y destino; en edición
  se manda únicamente el cambio y la referencia OP cuando hace falta seleccionar.
  El mandato expone máximo, moneda y ventanas. Sin equipo, peso, devolución, notas,
  restricciones ni pago en los argumentos de voz. Se conservan columnas y términos
  históricos; no se prometen cambios fuera del schema. El borrador sigue admitiendo
  datos parciales y el mandato de actualización hereda los términos omitidos.
- El juez `gpt-5.4-mini` responde únicamente con el ID del candidato validado por
  SQL. Sin explicación del modelo ni revisión humana. Fallos técnicos se reintentan,
  no se reemplazan por una selección presentada como si viniera del LLM. La
  migración `170000` elimina el bloqueo por ambigüedad sin quitar filtros de mandato.

- El agente proveedor ve el tope real por OP en contexto interno para comparar
  precios rápidamente. Tiene prohibido decirlo o usarlo como contraoferta. No
  aparece en las tools/listados; Postgres sigue validando. Esto reemplaza la
  decisión anterior de ocultarlo también del modelo, no permite divulgarlo al
  transportista y no promete confidencialidad garantizada solo por el prompt.

- El prompt de negociación se redujo: ante `contraoferta`, pedir una mejora de
  precio conservando el resto, no volver a recopilar toda la cotización.
- Confirmar una vez solo el precio («900 mil, para este viaje, ¿confirmás?»).
  El sí autoriza la propuesta para adjudicar si resulta elegida; no otra aprobación.
- `create_quote` recibe solamente `price_range: { min, max }` y, para elegir
  operación, `operation_reference`. Moneda, ventana, pago, vigencia y condiciones
  ya no están en los argumentos. El backend usa la moneda y primera ventana
  cronológica autorizada del mandato; las revisiones preservan la ventana anterior.
- Pago, vigencia y condiciones adicionales se guardan en null si no estaban
  acordados. Si el mandato contiene un mínimo de pago positivo, se conserva.
  No se borran términos históricos. Nunca interpretar null como pago inmediato.
- No preguntar campos opcionales ni solicitar nuevamente fechas. Una condición
  no soportada que el proveedor mencione no se ignora: se ofrece ayuda humana.
- Se conservan tres revisiones, validación del servidor, privacidad del mandato,
  tratamiento de negativas y escalación. Un trigger rechaza cualquier revisión
  que cambie algo distinto del precio o repita el mismo precio.
- Migraciones `130000`–`150000`: revisión del juez, términos fijos y nullable extras.
  Detalles de selección y límites: [bidding mínimo](bidding-minimal.md).
- Prompt de ambas personas: rapidez, frases cortas y sin repetir aprobaciones.
  Voz cedar a 1.2x (antes 1.05x); no cambia el modelo ni el VAD.
- Sin ejecución de tests, llamadas o migraciones remotas.
