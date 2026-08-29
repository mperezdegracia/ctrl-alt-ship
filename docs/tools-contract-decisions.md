# Decisiones del contrato de tools

**Estado:** acordado durante el grill de la issue #1

**Fecha:** 2026-08-29

## Seguridad y contexto

- El servidor autentica la contraparte por caller ID. El modelo decide la
  intención conversacional, no la identidad.
- UUIDs y contexto interno nunca son argumentos controlados por el modelo. El
  sideband resuelve llamada, contraparte, operación, mandato, pedido de
  cotización, booking y evidencia.
- Las referencias públicas `OP-000001` sirven para desambiguar operaciones y
  siempre se validan contra la contraparte autenticada.
- La disponibilidad de una tool orienta al modelo, pero no autoriza la acción:
  cada handler vuelve a validar persona, estado, propiedad e idempotencia.

## Inyección dinámica y bloqueo de camino

- Las tools se reemplazan durante la sesión mediante `session.update`.
- Cliente inbound y provider inbound pueden comenzar con intención `undecided`
  y sin operación. La primera mutación vincula una operación y bloquea el camino.
- Cliente: entrada con listar, crear, actualizar o cancelar. Después de elegir,
  desaparecen los caminos incompatibles.
- Provider outbound: el servidor conoce operación y objetivo, por lo que expone
  únicamente cotizar, confirmar booking o renegociar, junto con su negativa y
  `escalate`.
- Provider inbound: puede listar sus operaciones activas y elegir cotizar o
  rechazar el pedido, confirmar o rechazar un booking pendiente, reprogramar,
  cancelar booking o escalar. Después de elegir se bloquea el flujo.
- `escalate` queda disponible solamente para la persona provider en V1.

## Prompt y sesión Realtime

- El runtime usa `gpt-realtime-2.1` con `reasoning.effort: low` para equilibrar
  selección de tools y confirmaciones con latencia telefónica.
- La salida de audio usa la voz `cedar` a velocidad `1.05`. La voz se fija antes
  de producir el primer audio porque no puede cambiarse después dentro de la
  misma sesión.
- El saludo inicial es en inglés. El agente sólo cambia de idioma ante un pedido
  explícito o una intervención sustantiva en otro idioma; nombres, direcciones,
  acentos o palabras aisladas no disparan el cambio.
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
- Cambiar cualquier término operativo activa
  `mandate_confirmation_required`. Hasta una nueva confirmación se bloquean
  sourcing, contacto con providers y cambios de booking.
- Los importes viajan como números JSON por simplicidad y se convierten a
  `numeric` en el servidor.

## Cancelaciones del cliente

- `cancel_operation` es cancelación lógica, nunca `DELETE`.
- Requiere confirmación verbal explícita y termina el flujo de tools.
- Si ya existe provider o booking, la cancelación se notifica por email
  idempotente; no requiere confirmación telefónica del provider.

## Cotización y negociación

- `create_quote` recibe rango mínimo/máximo, moneda, ventana, plazo de pago,
  vigencia y condiciones. No recibe IDs internos.
- El servidor evalúa `price_max` contra el mandato y selecciona por el menor
  `price_max` válido: el menor peor caso.
- Existe exactamente una contraoferta por pedido. La primera propuesta completa
  fuera por precio devuelve `contraoferta`, incluso si su mínimo supera el tope.
  Una segunda propuesta aún fuera devuelve `fuera`.
- El precio máximo del cliente nunca aparece en respuestas a tools de provider.
- Errores estructurales y conflictos con términos fijos no consumen la ronda.
- Las negativas explícitas se guardan como estado y evento, sin crear quote ni
  compromiso.

## Booking, cambios y escalación

- `confirm_booking` requiere aceptación verbal y un precio final exacto dentro
  del rango elegido y del mandato. La referencia del provider es opcional.
- `reschedule_booking` sólo cambia la ventana y conserva precio y condiciones.
  Fuera de `action_windows` no aplica nada y requiere escalación.
- Si el provider exige otro precio, presenta una nueva cotización; no se modela
  como reprogramación.
- `cancel_booking` representa que el provider abandona el compromiso: crea el
  rastro de cancelación, devuelve la operación a sourcing y avisa al cliente.
- Una negativa de booking o reprogramación conserva evidencia pero no crea un
  compromiso aceptado.
- `escalate` entrega al supervisor compromisos, mandato y motivo. Nunca envía el
  transcript crudo ni revela el tope.
