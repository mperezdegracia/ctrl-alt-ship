# Tango: cotización y negociación del transportista

Implementación local, 2026-08-30. Primer tramo de tools de proveedor; no completa
todo el #13. Reprogramación/cancelación de reservas confirmadas se documentan en
[provider-booking-changes.md](provider-booking-changes.md). No se aplicó a Supabase ni se desplegó.

**Actualización del merge:** el worker ya compara, adjudica y encola emails de
confirmación. Las referencias siguientes a esas capacidades como pendientes
describen el primer tramo aislado. Rigen las decisiones y el despliegue en
[provider-sourcing-merge-decisions.md](provider-sourcing-merge-decisions.md), incluida
la migración `20260830090000_integrate_provider_sourcing.sql`.

## Decisiones actuales

- Nombre **Tango**. Prompt adaptado del texto de negociación aportado por Lucas:
  tranquilo, curioso, preguntas cortas, entender el motivo del precio, no ceder
  sin autorización, aclarar contradicciones y no interpretar ambigüedad como acuerdo.
- Varias rondas: tres contraofertas por pedido por defecto, además de la propuesta
  inicial. El límite vive en `quote_requests.negotiation_limit` (1–10); lo controla
  el backend. Los intentos consumidos se cuentan en las quotes persistidas.
- No revela el tope del mandato y no inventa un target ni una contraoferta numérica.
  Pregunta qué puede mejorar el proveedor para los mismos requisitos.
- No consulta ni usa precios de otros transportistas, según la última decisión.
- No envía ni encola correos. No promete una reserva, selección ni dispatch.
- Consentimiento conversacional, sin `needsApproval` ni tracker de audio. El
  backend valida datos, permisos y estado, no prueba que un humano dijo sí.

## Tools y perfiles

`CreateQuoteTool` y `DeclineQuoteRequestTool` delegan a `ProviderQuoteService` y
`SupabaseProviderQuoteRepository`. No aceptan UUIDs, identidad, veredicto ni evidencia.

- Inbound elegible: listar operaciones, crear quote, rechazar pedido y escalación
  existente si está configurada. Primer éxito fija operación e intención quote.
- Outbound: usa la operación/intención persistidas. Solo cotizar/rechazar/escalar;
  no permite cambiar a otra operación ni crea pedidos de cotización automáticamente.
- Mientras negocia: cotizar/rechazar/escalar, sin los demás caminos.
- Quote `dentro`, `fuera` definitivo o negativa guardada: perfil terminal sin tools.
- Sin pedido vigente o bajo mandato desactualizado: no expone tools de escritura.
  El listado sigue disponible solo si la llamada no está ligada a una operación.
- El contador legado que escalaba tras tres intervenciones ya no se conecta al
  runtime: recopilar una cotización completa no es un estancamiento.
  Se conserva el handoff explícito existente, que todavía es un POC.

`RealtimeSession` actualiza tools y prompt antes de entregar el resultado y
continuar. Las tools de cliente permanecen aisladas de las del proveedor.

## Evaluación y transacción

La nueva migración incorpora `get_provider_quote_tool_state` y
`execute_provider_quote_tool`. Comparte `tool_command_receipts` con el cliente.

La transacción revalida llamada activa, identidad y proveedor activo, relación con
el pedido, operación en sourcing/quotes_received, mandato vigente, expiración y
camino. Bloquea llamada, operación y pedido; rechaza una revisión de operación,
mandato o quote anterior distinta de la leída por el servidor. Ese contexto privado
no se publica en el prompt ni es un argumento controlado por el modelo.

Cada pedido queda ligado a su mandato; actualizarlo exige un nuevo pedido, no
reusar una autorización vieja. La migración liga pedidos históricos al mandato de
su última quote o, si no existe, al actual. El trigger completa el mandato en nuevas
inserciones y prohíbe cambiar operación, provider o mandato de un pedido existente.
El estado considera hasta 50 operaciones candidatas y el pedido accionable más
reciente para cada una. No hay paginación de candidatos en este tramo.

La cotización exige rango ordenado positivo (dos decimales), moneda, ventana
completa con zona horaria, plazo entero desde factura, expiración futura y notas.
SQL vuelve a validar todo. Evalúa `price_max`, no `price_min`.

- Precio dentro del tope y resto compatible: `dentro`, terminal. Si estaba en
  sourcing, la operación pasa a quotes_received.
- Precio fuera, con rondas disponibles: `contraoferta`; queda abierta para otra
  propuesta completa, confirmada y versionada.
- Precio fuera al agotar el presupuesto: `fuera`, terminal. No se adjudica nada.
- Moneda/ventana/plazo incompatibles: `fixed_terms_conflict`, sin quote ni ronda.
- Notas nuevas distintas de restricciones/cargo_notes existentes también requieren
  aclaración/escalación; no se intenta decidir semánticamente si texto libre es
  compatible. `conditions.notes: []` significa sin condiciones adicionales, nunca
  autorización para omitir condiciones que el transportista sí haya mencionado.

Cada éxito guarda quote inmutable (si corresponde), relación `supersedes`, evento,
estado y recibo en una transacción. Una negativa usa estado cancelled del pedido
con `provider_decline_reason` y `provider_declined_at`, emite quote.declined y no
crea una quote ni un compromiso. Same call/tool ID con mismos argumentos devuelve
el resultado original incluso terminado el flujo; argumentos distintos fallan.
Revalida autorización antes del replay. Volver a llamar no renueva las rondas.

El resultado expone `negotiation_remaining` y `negotiation_rounds_remaining`.
Si todas las propuestas fallan solo por precio, los restantes son 3 → 2 → 1 → 0.
Una propuesta válida cierra antes y devuelve 0. No se publica el tope.

## Pendientes y límites

- Selección automática por menor price_max y creación/confirmación de bookings
  siguen pendientes. Cambios de reservas ya confirmadas tienen un tramo separado.
- Tampoco crea registros `commitments`: hoy requieren excerpt/checkpoint de
  grabación y no se fabrica esa evidencia. Una quote guardada no equivale a booking.
- Un error de condiciones fijas informa la incompatibilidad sin exponer los
  límites exactos; insistencias ambiguas deben resolverse con un humano.
- Comparativas de otros providers y un objetivo/precio de contraoferta autorizado
  por servidor no se implementan todavía.
- Tests RPC simulados no demuestran ejecución SQL, concurrencia ni consentimiento.

## Despliegue

1. Aplicar `supabase/migrations/20260830070000_provider_quote_tools.sql` después de
   las migraciones previas, seguida de `20260830080000_provider_booking_changes.sql`.
   El backend actual usa `get_provider_tool_state`, que combina ambos tramos.
   No cambiar archivos ya aplicados.
2. Desplegar el backend. Las tools de proveedor se habilitan directamente, sin
   variable de entorno ni feature flag. La migración debe estar aplicada primero;
   si falta, la carga del estado de proveedor falla y la llamada se rechaza.
3. Reiniciar/redeployar y verificar `provider_quote_tools_enabled: true` al iniciar.
4. Usar pedidos de cotización vigentes ligados al mandato actual. El endpoint
   outbound por sí solo no crea esos pedidos. El sourcing automático aún no existe.

No se cambiaron los secretos ni `.env` local, no se ejecutó el seed ni se tocó la base.

## Prueba manual con un transportista

Preparar un pedido de prueba propio, vigente y sin booking para Theo/Mateo/Paki.
Una quote previa `dentro` no está abierta a editar; para otra negociación hace falta
otro pedido. Una contraoferta previa del seed consume una ronda del mismo pedido.

1. Esperar saludo en inglés, responder en español: «Quiero cotizar la OP-…».
2. Ofrecer rango, moneda, ventana con fecha/hora/zona, plazo desde factura,
   vigencia explícita y condiciones. No usar fechas vencidas.
3. Antes del resumen final preguntar o corregir un dato. No debe guardar todavía.
4. Confirmar el resumen con un sí en el siguiente turno. La tool registra la quote.
5. Si devuelve contraoferta, Tango pregunta tranquilamente si puede mejorar el
   rango. Proponer otra cifra, escuchar resumen y confirmar de nuevo. Repetir
   dentro del presupuesto de rondas. No debe mencionar el precio máximo del cliente.
6. Puede terminar con una quote válida, fuera definitivo o «No puedo mejorar y no
   quiero seguir cotizando». La negativa explícita guarda decline y termina.
7. Tras terminar, pedir otro cambio: no debe mutar en esa llamada ni anunciar booking.
8. En pruebas separadas: proveedor ajeno, request vencido, mandato cambiado, fixed
   terms y reconexión durante contraoferta. Deben conservar permisos y presupuesto.

## Validación local

`npm --prefix backend run typecheck`, `harness:tools:provider` y los harnesses
existentes de cliente, lecturas, Agents SDK y diagnósticos. El nuevo harness usa
RPCs/respuestas en memoria y transporte SDK simulado; las aserciones SQL son
estáticas, no pruebas PostgreSQL. Sin llamadas reales, emails o escritura en Supabase.

El prompt sigue las reglas explícitas por tool y las transiciones conversacionales
de [OpenAI Docs: Realtime prompting](https://developers.openai.com/api/docs/guides/realtime-models-prompting).
