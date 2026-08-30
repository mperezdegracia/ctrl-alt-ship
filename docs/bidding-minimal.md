# Bidding mínimo y revisión del juez

Decisión 2026-08-30: el proveedor negocia únicamente precio. El mandato del cliente
sigue siendo corto: ruta, máximo/moneda y ventanas de retiro. No añadir requisitos
para que el juez pueda trabajar.

## Llamada

Presentar brevemente ruta y retiro conocidos, pedir el precio y una aprobación
breve para adjudicar si se selecciona esa propuesta. Tool:

```json
{"price_range":{"min":900000,"max":900000}}
```

`operation_reference` es opcional para seleccionar una operación disponible.
Moneda y retiro no son argumentos: vienen del mandato. Para un mandato con varias
ventanas, se usa la primera en orden cronológico, expuesta en el contexto verificado.
No se inventa ni amplía una ventana; si esa ventana pasó, no se avanza silenciosamente
a otra. En revisiones se conserva la ventana de la propuesta previa.

Pago, vencimiento y condiciones adicionales no se preguntan ni aparecen en la tool.
Se guardan en SQL null salvo términos existentes que deben conservarse. Un mínimo
de pago positivo del mandato sí se conserva; cero significa ausencia de restricción,
no acuerdo de pago inmediato. Null de vigencia significa sin vencimiento adicional:
siguen vigentes los controles de mandato actual, solicitud abierta y retiro futuro.
No se hace un backfill para borrar información histórica.

Hasta tres revisiones de precio después de la oferta inicial. Postgres bloquea
cualquier cambio de moneda, fecha, pago, vigencia o condiciones, y las ofertas sin
cambio de precio. Si el proveedor pide una concesión no soportada, no omitirla:
ofrecer revisión humana. Reprogramación/cancelación de reservas existentes son
flujos separados y no se eliminan con este cambio.

## Cuándo cerrar

El loop sigue dentro del backend. Postgres decide si todas las negociaciones
terminaron o si pasaron cinco minutos desde el primer `dispatched_at`.
Una contraoferta abierta no cuenta como negociación terminada. Sin una oferta
válida, se sigue esperando; no se genera un booking vacío.

Dentro del plazo se ordena por menor `price_max` y luego recepción/ID. Fuera del
plazo se conserva la regla anterior: prioridad a la primera oferta válida tardía,
no pagar más por una supuesta calidad sugerida por el modelo.

## Juez acotado

El agente de voz también recibe `privatePriceLimits` por OP, con el tope y moneda
del mandato vigente, en un bloque interno separado. Puede comparar el precio del
proveedor para avanzar rápido, pero no decir el tope, confirmar una adivinanza ni
filtrarlo como diferencia, porcentaje o contraoferta. El tope no aparece en los
argumentos/resultados de `create_quote` ni en los DTOs de listados. Se conservan
las validaciones de Postgres. La migración `160000` incorpora este contexto solo
para solicitudes disponibles del proveedor autenticado.

Esta es una política del prompt, no una garantía técnica de confidencialidad: al
darle el dato al modelo existe riesgo de que lo revele. OpenAI Docs aclara que las
[instrucciones de Realtime no garantizan cumplimiento](https://developers.openai.com/api/reference/python/resources/realtime/subresources/calls/methods/accept).

`AgentsSourcingJudge` usa Agents SDK, salida estructurada y `gpt-5.4-mini`, sin
tools ni permisos de booking. SQL elige primero al candidato elegible. El LLM
ratifica ese candidato con una sola salida: `{"selected_quote_id":"UUID"}`.
No devuelve explicaciones, alternativas ni pedidos de revisión humana. Se valida
que el ID coincida con el candidato preparado; no renegocia ni inventa requisitos.
El texto de auditoría persistido se genera en el backend, no es otra respuesta LLM.

`prepare_sourcing_review` genera el contexto y su hash: operación/revisión,
mandato actual, propuestas elegibles, candidato y regla aplicada. El modelo no
ve teléfonos, emails ni grabaciones. Los campos de texto son datos no confiables,
no instrucciones. Tracing deshabilitado y `store: false`.

`record_sourcing_review` vuelve a comprobar ese contexto bajo lock antes de
guardar en `sourcing_judge_reviews`. Cada contexto conserva una revisión inmutable;
no se llama al modelo cada cinco segundos si ya existe. Tiempo máximo del modelo:
20 segundos; fallos reintentables esperan 60 segundos en el proceso.

`finalize_operation_sourcing` vuelve a calcular elegibilidad y contexto antes de
confirmar. Revisión faltante, desactualizada, inválida o timeout no permiten
adjudicar; se reintenta automáticamente, sin fingir que hubo respuesta del LLM.
La migración `170000` elimina el veto humano de `review_required`, incluso en una
revisión histórica del mismo contexto. Nuevas respuestas siempre se registran como
`clear`. No hay fallback sin LLM para evaluaciones nuevas ni estado de ambigüedad
que requiera intervención humana. Siguen vigentes todos los filtros deterministas.

La revisión no habilita condiciones nuevas que el filtro SQL rechace. SQL sigue
siendo la autoridad para límites, equipo especificado y ofertas antiguas. Para
cotizaciones mínimas sin condiciones, la revisión será normalmente simple.

El booking queda confirmado en DB y se encolan emails; no se espera la entrega del
email para cambiar el estado. Esto no acredita evidencia de audio ni una aceptación
legal, y no implementa todos los puntos del challenge.

## Logs y despliegue

- `sourcing.worker_poll`: cada vuelta, incluso vacía; cinco segundos de espera más
  el trabajo de la vuelta (incluida la revisión cuando corresponde).
- `sourcing.judge_started/completed/stale/failed`: IDs, hash, modelo y duración.
- `sourcing.decision`: espera, reintento técnico o adjudicación; `review_id` permite
  consultar la decisión persistida. `quote.selected` referencia la revisión.

Aplicar migraciones `120001`, `130000`, `140000`, `150000`, `160000`, `170000` y desplegar el backend
compatible antes de validar. Runtime viejo con argumentos completos no es compatible
con el RPC de precio mínimo. No se ejecutaron tests, typecheck, llamadas ni SQL remoto.

La guía OpenAI Docs influyó en el uso de salida estructurada, revisión acotada y
separación entre evaluación y ejecución:
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs),
[evaluación y criterios de jueces](https://developers.openai.com/api/docs/guides/evaluation-best-practices).
La velocidad compartida ahora es 1.2x; el prompt pide brevedad sin hablar encima
del usuario. [Configuración de velocidad Realtime](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/accept).
