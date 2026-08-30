# Plan ejecutable: llamadas de Proveedores, contexto y recuperación

Fecha: 2026-08-30. Estado: planificación; no implementado ni desplegado.

Objetivo: entregar el flujo completo del MVP sin rehacer telefonía, SDK, UI ni
negociación. Este documento fija contratos y divide el trabajo para que los
subagentes implementen pasos concretos, sin inventar reglas de producto.

Los acuerdos de producto están en [provider-call-flow-design.md](provider-call-flow-design.md).
Este documento precisa su implementación. Los valores operativos de un minuto
y las decisiones de estructura que siguen son decisiones técnicas del plan,
no respuestas textuales del usuario. No quedan preguntas de producto bloqueantes.

Restricción explícita posterior del usuario: HITL y llamadas ya funcionan y fueron
probados. Se conservan. Este trabajo end to end no incluye escribir ni ejecutar
pruebas, harnesses, mocks, fixtures, QA ni llamadas de validación. End to end
significa implementar y conectar el cambio completo sobre esas piezas existentes.

## 1. Resultado observable y límites

| Situación | Resultado requerido |
| --- | --- |
| Proveedor llama | Solo gestionar sus Bookings: listar, elegir modificar o elegir cancelar. |
| Pide una persona al inicio | Primero identificar Booking y acción; luego habilitar `escalate`. |
| Elige modificar | Selección sin cambios de reserva; luego cambiar solo fecha/horario de retiro con confirmación. |
| Cambio fuera de Mandato o de precio/ruta | No aplicarlo; revisión humana con la reserva intacta. |
| Elige cancelar y confirma | Cancelar su Booking, no la Operación del Cliente; iniciar búsqueda de reemplazo. |
| Búsqueda de reemplazo | Contactar al otro cotizante no elegido y sumar un Proveedor nuevo, si existen. |
| Tango llama | Registrar cada oferta y cotizar/rechazar para la Operación seleccionada por el servidor. |
| Transportista propone un precio | Guardar evento siempre, dentro o fuera de rango; registrar no significa aprobar. |
| Devuelve una llamada | Sigue siendo entrante; no habilitar cotización en el MVP. |
| No atiende | Hasta dos reintentos adicionales, tres llamadas en total por Proveedor y búsqueda. |
| Ocupado, error, atendió y cortó o rechazó el trabajo | No volver a llamar automáticamente. |
| Recuperación sin reemplazo | Operación abierta en `needs_follow_up`, sin nuevas rondas ni transferencia telefónica. |
| Gestión terminada | Sin tools de nuevas gestiones; un Booking y una acción por llamada. |

Conservar la política comercial, precio, modelo, voz, idioma inicial, VAD y emails
de adjudicación existentes. No agregar emails de modificación/cancelación, UI de
aprobación, callbacks de cotización entrantes, marcado arbitrario ni un framework
de workflows. No fabricar evidencia de audio ni compromisos.

`handoff_recipients` y Directory siguen siendo la autoridad del destinatario humano.
No hardcodear teléfonos ni agregar `SUPERVISOR_PHONE` o flags equivalentes.
El `9` de móviles argentinos se aplica al destino saliente; no normalizar por ello
el caller ID entrante usado para autenticar.

## 2. Diagnóstico que deben conocer todos los implementadores

| Problema actual | Evidencia local | Cambio necesario |
| --- | --- | --- |
| Scope no distingue dirección | `backend/src/domain/operation-read-service.ts`, `ToolCallScope` | Dirección/propósito inmutables y obligatorios. |
| Factory construye cotización y booking juntos | `backend/src/tango/tools/call-tool-factory.ts` | Construir solo las tools de la familia correcta. |
| Primera oferta no se registra antes de negociar | `provider-quote-instructions.ts` posterga create_quote hasta aprobación | Registro de oferta separado de adjudicación. |
| Entrada incluye cotización y escalación | `backend/src/tango/tools/call-tool-session.ts` | Tabla de perfiles cerrada. |
| Elegir intención ocurre al mutar | `20260830080000_provider_booking_changes.sql` | Selección durable independiente de la mutación. |
| Todo proveedor recibe instrucciones de precio | `backend/src/tango/agents/routing-instructions.ts` | Sacar reglas comerciales del bloque compartido. |
| Contexto combina bookings, quotes y topes | `backend/src/tango/agents/provider-quote-instructions.ts` | Proyectores separados, sin serializar el estado completo. |
| SQL de estado de booking llama primero al de quote | `get_provider_tool_state`, migración `080000` | Ramificar por dirección/propósito antes de consultar datos. |
| Quote y booking validan intención, no dirección | `execute_provider_quote_tool`/`execute_provider_booking_tool` | Validar la familia incluso si una tool vieja llega a ejecutar. |
| Escalación puede elegir Operación por sí misma | `create_call_escalation`, migración `180000` | Proveedor entrante necesita selección previa; no usar escalación como selector. |
| Cancelar no encola contactos nuevos | `execute_provider_booking_tool`, migración `080000` | Cancelación y creación de recuperación en la misma transacción. |
| Requests/reloj se agrupan por Mandato | migraciones `110000`, `150000`, `170000` | Identidad de ronda para repetir búsqueda sin otro Mandato. |
| Callback pierde el status concreto | `backend/src/server.ts`, `/twilio/call-status` | Persistir resultado Twilio y programar solo `no-answer`. |
| Se reintenta error de dispatch | `finish_provider_contact`, migración `090000` | Quitar rediscado por fallo técnico. |

Las abreviaturas de migración en esta tabla corresponden al prefijo
`supabase/migrations/20260830`. Revisar la definición más nueva de cada función,
no copiar el cuerpo de la primera migración que la creó.

La auditoría del plan identificó los puntos a modificar. No convertirla en una
reimplementación o revalidación de funcionalidades que el usuario ya probó.

## 3. Arquitectura elegida

```text
Webhook OpenAI verificado
  → routing y correlación persistida
  → CallScope: identidad + dirección + propósito
  → carga de estado autorizado en SQL
  → perfil: tools permitidas + proyección de contexto
  → una RealtimeSession SIP para esa llamada
  → tool SDK → servicio → RPC transaccional
  → refrescar estado → updateAgent → resultado → continuación del SDK

Cancelación confirmada
  → Booking cancelado + nueva ronda + Outbox, en una transacción
  → worker → intento persistido → Twilio
  → callback firmado → status + posible retry durable
  → nuevas llamadas salientes, cada una con su propia sesión
  → adjudicación normal o needs_follow_up
```

Hay dos fronteras diferentes: separación de datos que recibe el modelo y
autorización de las acciones del servidor. Cumplir ambas. Un prompt que prohíbe
cotizar no reemplaza una RPC que rechaza cotización entrante.

## 4. Contrato de identidad y routing

Crear `backend/src/domain/call-flow.ts` para estos tipos compartidos. Mantener
`ToolCallScope` como export compatible de ubicación si evita churn de imports,
pero no conservar un valor opcional/default para dirección de Proveedor.

```ts
type CallIdentity = Readonly<{
  callId: string;             // calls.id, no el ID de OpenAI
  realtimeCallId: string;
  counterpartyId: string;
}>;

type ToolCallScope = CallIdentity & (
  | { persona: 'client'; direction: 'inbound'; purpose: 'operation_management' }
  | { persona: 'provider'; direction: 'inbound'; purpose: 'booking_management' }
  | { persona: 'provider'; direction: 'outbound';
      purpose: 'quote_request' | 'renegotiation' | 'booking_replacement' }
);
```

- Persistir `calls.purpose`; conservar `calls.direction` y `provider_intent`.
- En salientes, `calls.quote_request_id` identifica exactamente la solicitud;
  nunca resolver «la última solicitud de este proveedor» para ejecutar una tool.
- `operation_id`, `provider_id`, propósito, request y ronda vienen del trabajo
  persistido. No aceptar estos IDs en argumentos del modelo ni un teléfono libre.
- `realtime.call.incoming` describe llegada a OpenAI, no dirección de negocio.
- Header `X-Tango-Call-Id` presente pero vacío, duplicado contradictorio, inválido
  o desconocido: rechazar; no usar fallback entrante.
- Sin ese header, solo usar el circuito entrante autorizado por caller ID.
- Vincular una llamada saliente al ID Realtime una sola vez; repetición con el
  mismo ID es idempotente, otro ID para el mismo intento se rechaza.
- Conservar la correlación SIP/Twilio que ya funciona. No agregar una columna de
  SID de pierna, nuevas consultas a Twilio ni rehacer la conexión SIP para este
  cambio. El nuevo callback de reintentos se liga a `calls.id` y conserva el SID
  padre existente; no sobrescribirlo con otro SID.
- Revalidar Proveedor activo, request y ronda vigentes al aceptar salientes.
  Una llamada ya seleccionada/cancelada no abre otra negociación.
- `persistRoutedCall` no crea una fila inbound para reparar una outbound no
  encontrada. Debe conservar dirección, propósito e intención de la fila existente.
- No abrir una sesión sideband nueva para cambiar de perfil. Conservar el
  ciclo de vida de sesión existente sin introducir otro registro de sesiones.

## 5. Máquina de estados y tools exactas

No sumar un router LLM ni tools genéricas de cambio de rol.

| Perfil de Proveedor | Tools anunciadas | Estado/contexto |
| --- | --- | --- |
| `provider_inbound_entry` | `list_provider_operations`, `select_booking_for_reschedule`, `select_booking_for_cancellation` | Resúmenes de Bookings propios; intención sin decidir. |
| `provider_reschedule` | `reschedule_booking`, `escalate` | Un Booking seleccionado, intención `reschedule`. |
| `provider_cancel_booking` | `cancel_booking`, `escalate` | Un Booking seleccionado, intención `cancel_booking`. |
| `provider_booking_escalation` | `escalate` | Solicitud fuera de autorización, sin cambio aplicado. |
| `provider_quote` | `record_provider_offer`, `create_quote`, `decline_quote_request`, `escalate` | Solo saliente, request/ronda/Operación ya fijados. |
| `provider_unavailable` | ninguna | No hay gestión autorizada; explicación y cierre. |
| `terminal` | ninguna, `tools: []` explícito | Resultado seguro de la acción; cierre. |

Entrada sin Bookings: mantener `list_provider_operations` para refrescar, retirar
selectores mientras la lista esté vacía. No inventar una reserva para escalar.
Al seleccionar, desaparecen listado y ambos selectores. No se cambia de acción o
pedido a mitad de la gestión. Si el Proveedor se arrepiente antes de confirmar,
no ejecutar nada y cerrar; no hace falta una tool de «cancelar la cancelación».

### Selección: contrato nuevo

Ambas tools reciben exactamente lo siguiente y nada más:

```json
{ "operation_reference": "OP-900001" }
```

Schema: objeto cerrado, referencia requerida con `^OP-[0-9]{6,}$`. La acción se
deduce del nombre de la tool; no ofrecer un parámetro libre `intent`.

RPC única de selección:

```text
select_provider_booking(
  p_call_id uuid, p_realtime_call_id text, p_provider_id uuid,
  p_tool_call_id text, p_tool_name text, p_arguments jsonb
) -> {
  status: "selected",
  operation_reference: string,
  intent: "reschedule" | "cancel_booking"
}
```

La transacción valida inbound/booking_management, llamada activa, proveedor
activo y dueño del Booking confirmado mediante quote → request → provider.
Bloquea llamada, Operación y Booking; persiste `calls.operation_id`,
`calls.selected_booking_id` y `calls.provider_intent`, más recibo idempotente.
No cambia Booking, Operación, Mandato, `change_requests` ni Outbox.
Si no hay exactamente un Booking propio confirmado para esa referencia, falla.

El agente puede seleccionar sin otra pregunta si el Proveedor ya dijo claramente
«quiero modificar la OP-…». Selección explícita no significa agregar una
confirmación verbal artificial; la aprobación exigida es antes del cambio real.

Después de seleccionar, `reschedule_booking`/`cancel_booking` conservan sus
argumentos actuales. `operation_reference`, si se envía, debe coincidir con la
seleccionada; su omisión usa el vínculo persistido. Nunca seleccionan por sí mismas.

### Reglas transaccionales y replay

- Nuevas mutaciones exigen intención exacta, Booking seleccionado aún propio,
  dirección/propósito correctos, estado no terminal y revisión vigente.
- `create_quote`/`decline_quote_request` exigen outbound y la request exacta de
  esa llamada, vigente en su ronda. No permiten elegir otra Operación.
- `create_call_escalation` no puede completar una selección faltante en inbound
  de Proveedor. Requiere Booking + intención ya persistidos y referencia coincidente.
- Autenticar identidad y familia antes de consultar/devolver un recibo. Luego
  distinguir replay idéntico de comando nuevo: el primero devuelve el resultado
  guardado sin cambiar etapa; el segundo debe cumplir la etapa actual.
- Mismo `(call_id, tool_call_id)` con otros argumentos/nombre:
  `idempotency_conflict`. Preservar comprobaciones de actividad existentes; no
  ampliar permisos de replay de llamadas terminadas como parte del refactor.
- Escalación durable requiere especial cuidado con su replay: nunca preparar
  otra transferencia porque se volvió a devolver el recibo. Conservar coordinador
  y unicidad por llamada; no convertir `agent_handoff` del SDK en una transferencia.
- Un replay de cancelación no crea otra ronda. Un tool viejo desde otra respuesta
  no puede cruzar de modificar a cancelar, ni de entrante a cotizar.
- `stale_operation`: refrescar y volver a confirmar diferencias; nunca reusar
  el sí anterior. Selección fija el ID del Booking, no solo la Operación, para
  que un reemplazo concurrente no se convierta en un nuevo blanco de cancelación.
- Nuevas RPCs solo para `service_role`; RLS/grants de las tablas nuevas deben
  mantener a `anon`/`authenticated` sin acceso directo. No confiar en UI oculta.

## 6. Separación de contexto: proyecciones obligatorias

Crear tipos discriminados `ProviderInboundState` y `ProviderOutboundState` en
`backend/src/domain/provider-call-state.ts`. Cada uno contiene `flow`, `profile`,
`intent` y sus campos específicos; no una bolsa de propiedades opcionales.

Forma interna que P0 debe publicar (los tipos de Booking/Operación/resultados
reutilizan los campos existentes, sin enviarlos completos al prompt):

```ts
type ProviderInboundState = {
  flow: 'provider_inbound';
  profile: 'provider_inbound_entry' | 'provider_reschedule'
    | 'provider_cancel_booking' | 'provider_booking_escalation'
    | 'provider_unavailable' | 'terminal';
  intent: 'undecided' | 'reschedule' | 'cancel_booking';
  bookings: ProviderBookingSummary[]; // vacía después de seleccionar
  selectedBooking: ProviderBooking | null;
  commandTarget: ProviderBookingTarget | null; // servidor, jamás prompt
  lastResult: ProviderBookingResult | null;
};

type ProviderOutboundState = {
  flow: 'provider_outbound';
  profile: 'provider_quote' | 'provider_unavailable' | 'terminal';
  intent: 'quote';
  operation: ProviderOperation | null; // solo la seleccionada por calls
  commandTarget: ProviderCommandTarget | null; // request exacta y revisión
  privatePriceLimit: { price_cap: number; currency: string } | null;
  lastQuote: ProviderLastQuote | null; // extraer el tipo existente, no reinventar
  lastOffer: { price_range: { min: number; max: number; currency: string } } | null;
};

type ProviderCallState = ProviderInboundState | ProviderOutboundState;
interface ProviderStateReader {
  getState(): Promise<ProviderCallState>;
  readonly currentState: ProviderCallState | undefined;
}
```

`ProviderBookingSummary` tiene `operation_reference`, `pickup_location`,
`delivery_location` y `pickup_window:{start_at,end_at}`. Conservar null donde
el dato real no existe; el agente aclara el dato necesario, no inventa defaults.
Después de una escalación se puede proyectar perfil terminal conservando la
intención elegida; no perderla aunque el storage legado use otro valor interno.

`ProviderBookingService` obtiene y conserva su propio estado inbound, incluyendo
la selección. `ProviderQuoteService` conserva el estado outbound. Ambos exponen
una interfaz mínima `getState()`/`currentState` para `CallToolSession`.
Eliminar la dependencia por la que `ProviderBookingService` necesita instanciar
`ProviderQuoteService` para conocer su reserva.

El wrapper SQL `get_provider_tool_state` ramifica desde `calls.direction/purpose`:
inbound consulta Bookings; outbound consulta la request exacta. Puede conservarse
el nombre del wrapper para reducir cambios, pero no componer ambos resultados.

| Proyección enviada al modelo | Campos permitidos | Campos prohibidos |
| --- | --- | --- |
| Entrada inbound | Nombre visible, dirección/propósito, referencias de Bookings propios, origen/destino y retiro actual. | Cotizaciones pendientes/anteriores, tope del Cliente, IDs/revisiones, competidores. |
| Modificar seleccionado | Referencia, ruta, retiro actual, resultado de la última acción, reglas de alcance. | Otros Bookings, cotizaciones, tope, Mandato completo. |
| Cancelar seleccionado | Referencia, datos mínimos del viaje, consecuencia y último resultado. | Topes, negociación y candidatos de reemplazo. |
| Outbound quote | Un pedido, moneda/ventana fijas, negociación propia, rondas comerciales restantes. | Otros pedidos, Bookings, cotizaciones de otros proveedores, transcript entrante. |
| Terminal | Resultado real de la acción, referencia y consecuencia. | Catálogo de caminos alternativos. |

Para modificación, SQL valida la ventana contra el Mandato. No hace falta mandar
ventanas privadas autorizadas al agente: puede recibir `applied` o
`requires_escalation`. La fecha actual sí se mantiene para interpretar fechas.

La política de contraoferta saliente existente utiliza el tope en instrucciones
internas. Mantener ese dato exclusivamente para la Operación saliente seleccionada,
en bloque privado del prompt; jamás enviarlo como respuesta de tool, log o saludo.
No describirlo como secreto inaccesible al modelo: el modelo sí lo ve. Sacar ese
cálculo del modelo sería otro cambio comercial/técnico, fuera de este MVP.

Construir proyecciones por allowlist de campos; prohibido `JSON.stringify(state)`
o extender la unión antigua y luego borrar algunas claves. Los mapas privados de
targets, revisiones, IDs y correlación solo existen en el servidor.

### Builders y lista

- Crear `provider-inbound-instructions.ts` y `provider-outbound-instructions.ts`.
- Conservar/reutilizar `ProviderBookingInstructions` y las reglas comerciales de
  `ProviderQuoteInstructions`, pero cada builder recibe solo su DTO de flujo.
- `RoutingInstructionsBuilder` comparte rol, idioma, fechas, seguridad y estilo;
  no comparte «preguntá solo el precio», contraofertas ni pasos de cancelación.
- Mantener separado el builder de Cliente; no alterar sus tools ni mandatos.
- `list_provider_operations` conserva nombre pero pasa a listar solo Bookings
  propios confirmados. DTO: referencia, origen, destino y ventana de retiro;
  no exigir contenedor/peso si la entrada mínima actual no los guarda.
- No cambiar consultas genéricas del dashboard para conseguir este filtro:
  añadir una consulta dedicada a Bookings de voz si la actual se comparte.
- No inyectar el catálogo entero también desde el routing inicial y desde el
  estado. La proyección del flujo es la única fuente de contexto de Proveedor.

Actualizar instrucciones no borra el historial. Los resúmenes que se listaron
antes de seleccionar permanecen en la misma llamada y eran datos permitidos.
No usar `updateHistory()` para intentar borrar el pasado ni reiniciar la sesión.
La autorización bloquea acciones sobre otros Bookings; cada llamada saliente
nueva tiene sesión e historial propios y no hereda la conversación de cancelación.

## 6 bis. Toda propuesta de precio se persiste como evento

Requisito explícito del usuario: todas las quotes del transportista quedan en
base como eventos, estén dentro o fuera del rango. Incluye precio inicial,
contraofertas y propuestas que finalmente no se aceptan. No aplicar un filtro
por precio antes de registrar, no guardar solo la ganadora ni solo el resumen
final. Registrar al recibir el importe, no al terminar la llamada.

Hoy `create_quote` ya inserta una versión en `quotes` y `quote.received` para
`dentro`, `contraoferta` y `fuera`. Mantenerlo. El hueco es que el prompt espera
al precio aprobado después de negociar: la primera oferta verbal puede perderse.

Solución mínima: agregar una tool outbound **`record_provider_offer`** que registra
la observación sin aprobarla y sin alterar el estado comercial.

```text
Tool record_provider_offer arguments:
{
  price_range: { min: number, max: number },
  currency?: string
}

RPC record_provider_offer(
  p_call_id uuid, p_realtime_call_id text, p_provider_id uuid,
  p_tool_call_id text, p_arguments jsonb
) -> { status: "recorded" }
```

Objeto cerrado; importe claro y positivo, min <= max. La moneda explícitamente
ofrecida se conserva; si no la dijo, usar la moneda verificada del pedido. No
convertir monedas ni fabricar un importe cuando el audio sea ambiguo: aclararlo.
Los IDs, timestamp y clasificación dentro/fuera los resuelve el backend, no el
modelo. Se reutilizan reglas de representación numérica, nunca el tope como
validación de entrada del registro.

Evento nuevo: **`quote.offered`**, append-only en `events`:

```text
operation_id, call_id, occurred_at, schema_version = 1
payload = {
  provider_id, quote_request_id, round_id,
  price_range: { min, max, currency },
  range_status: "within" | "outside" | "unassessed",
  speaker: "provider",
  approval: "not_requested_by_this_event"
}
```

`range_status` compara el máximo en la misma moneda con el Mandato de referencia;
si moneda/contexto no permite comparar, unassessed. No incluir el tope numérico
del Cliente en este evento. Es auditoría, no el veredicto completo de elegibilidad.

Comportamiento obligatorio:

1. En cuanto el Proveedor ofrece un importe para ese viaje, ejecutar el registro
   antes de responder con nuestra contraoferta. No pedir aprobación para guardar
   lo que acaba de decir ni pronunciar un preámbulo por cada evento.
2. Cada nueva propuesta/corrección del Proveedor genera un nuevo evento. La oferta
   que propone Tango no se registra como si la hubiera dicho el transportista.
3. No deduplicar por importe: dos propuestas del mismo monto en momentos distintos
   pueden ser hechos diferentes. Reintentar la misma invocación de tool sí devuelve
   su recibo sin duplicar el evento.
4. Registro y recibo se confirman en una transacción. Solo llamadas outbound
   autorizadas para esa request pueden registrar. No requerir que el precio esté
   dentro del Mandato ni que queden contraofertas comerciales disponibles.
5. El registro no consume contraofertas, no cambia status de request/Operación,
   no crea una fila elegible en quotes, no adjudica ni dispara emails.
6. Tras la aprobación verbal final, `create_quote` conserva su comportamiento:
   versión inmutable y evento `quote.received`, también si queda fuera. Vincular
   desde ese evento la `quote.offered` correspondiente usando contexto del servidor;
   si el registro faltaba, insertarlo en esa transacción sin perder la cotización.
7. No exigir IDs de eventos al modelo. No sobrescribir el evento original al
   aprobar una propuesta: `quote.received` expresa el hecho posterior.
8. Si falla el registro, no continuar negociando como si se hubiera guardado.
   Permitir repetir la escritura con la misma clave, sin otra llamada telefónica.
9. No cargar estos eventos de otros Proveedores en el contexto de voz. En saliente,
   el estado puede usar solo las ofertas de su propia request para no repetir
   preguntas o la contraoferta inicial al refrescar.

El guard del registro valida identidad y atribución al pedido; no debe rechazar
una oferta histórica observable solo por precio o términos comercialmente inválidos.
Guardar no concede permiso para aceptarla. Las tools de aprobación siguen
aplicando todas las validaciones de ronda, Mandato y estado actuales.

No transformar todos los números de una transcripción en ofertas mediante regex.
El agente identifica una propuesta de precio y la tool persiste el evento. Esta
captura depende de la interpretación del agente; no prometer transcripción perfecta
ni añadir otro modelo/worker de extracción para este MVP.

Agregar únicamente título/detalle de `quote.offered` en el feed de eventos del
backend (`tango/supabase/dashboard.ts`) para mostrar monto y clasificación con la
UI existente. No agregar pantalla, filtros de elegibilidad que oculten ofertas
fuera de rango ni un nuevo panel de negociación.

## 7. SDK: reutilizar correctamente lo existente

Versión auditada: `@openai/agents` y `@openai/agents-realtime` **0.17.0** en
`backend/package-lock.json`. No hacer upgrades ni cambiar modelo por esta tarea.

Conservar `AgentsCallSession`: una instancia de `RealtimeAgent`, una de
`RealtimeSession` y un `OpenAIRealtimeSIP` por llamada. El SDK gestiona parsing,
resultados de tools, historial y programación de respuestas; la aplicación
gestiona autorización y estado de negocio en SQL.

El orden de la implementación existente es el patrón a adaptar:

```ts
// Esquema orientativo dentro del callback execute existente, no otro runner.
const result = await callTools.execute(name, args, { toolCallId });
await callTools.refresh();
agent.tools = buildToolsForCurrentProfile();
agent.instructions = buildInstructionsForCurrentProfile();
await session.updateAgent(agent); // misma instancia; envía nueva configuración
return result;                    // SDK publica output y continúa
```

Reglas que no se pueden simplificar fuera:

1. Cargar estado correcto antes de `calls.accept`. `initialConfiguration()` usa
   el mismo agente/opciones que `connect`, no otra lista artesanal de tools.
2. `updateAgent` prepara/envía la configuración, no espera aceptación remota.
   Observar `session.updated` con diagnósticos existentes. No inventar correlación
   por `event_id` ni una barrera de ACK que el SDK no promete.
3. Conservar el arreglo `ObservedSIPTransport.buildSessionPayload` que emite
   `tools: []`: SDK 0.17 omite el campo vacío y dejaría tools anteriores activas.
4. Conservar wrappers SDK cacheados por nombre y schemas cerrados. El workaround
   `strict:false` del helper no permite argumentos extra en dominio/SQL.
5. Mantener `parallelToolCalls:false`, `historyStoreAudio:false` y
   `tracingDisabled:true`. No añadir trazas externas de audio/transcripts.
6. Tools normales devuelven resultado normal. No emitir otro `response.create`:
   el SDK ya programa la continuación. Las excepciones son saludo y despedida
   de transferencia existentes.
7. `backgroundResult` se usa solo para escalación preparada, con despedida única
   después de publicar el resultado. No usarlo para selección/cancelación.
8. No agregar `handoffs:[...]` entre agentes para elegir intención. El evento
   `agent_handoff` de `updateAgent` es interno y no significa handoff humano.
9. Si la escritura confirmó y falla el refresh, mantener el resultado de éxito,
   retirar tools y cerrar con seguridad. No anunciar rollback inexistente.
10. Si falla el envío de configuración, usar el cierre seguro existente; ninguna
    continuación con permisos viejos. No rehacer las colas de respuesta del SDK.
11. Una respuesta ya iniciada puede conservar un snapshot de tools antiguo.
    Validar siempre la acción actual en SQL aunque la tool exista en ese snapshot.
12. Transferencia: caso durable → destinatario de Directory → despedida → audio
    detenido → SIP REFER. REFER aceptado no demuestra que el humano atendió.

No cambiar VAD ni agregar parámetros de WebSocket que SIP rechaza. Conservar
`server_vad`, `create_response`, `interrupt_response`, voz y velocidad actuales.

Fuentes oficiales: [SIP y configuración antes de aceptar](https://developers.openai.com/api/docs/guides/realtime-sip),
[control del servidor por sideband](https://developers.openai.com/api/docs/guides/realtime-server-controls).
El detalle de `updateAgent`, tools vacías y colas se verificó en los tipos/fuentes
instalados de `backend/node_modules/@openai/agents-realtime/dist/`,
no se dedujo de ejemplos de otra versión.

## 8. Persistencia mínima para rondas y llamadas

Agregar una tabla de rondas y extender `calls`; no crear también otra tabla de
intentos con información duplicada. `calls.id` es el ID durable de cada intento.

### `sourcing_rounds` (nueva)

| Campo | Contrato |
| --- | --- |
| `id` | UUID, generado por base. |
| `operation_id`, `mandate_id` | FK requeridas y coherentes entre sí. |
| `kind` | `initial`, `renegotiation`, `replacement`. |
| `source_booking_id` | FK para replacement; única para no recuperar dos veces la misma cancelación. |
| `source_round_id` | Ronda del Booking cancelado; null en primera búsqueda. |
| `status` | `active`, `selected`, `exhausted`, `superseded`. |
| `first_dispatched_at` | Null hasta primera aceptación por Twilio; nunca se reinicia por retry. |
| `created_at`, `closed_at` | Instantes del ciclo. |
| `idempotency_key` | Única: inicial por Mandato, replacement por Booking cancelado. |

Índice único parcial: una ronda `active` por Operación. Crear constraints que
impidan source_booking ausente en replacement o perteneciente a otra Operación.

### Extensiones

- `quote_requests.round_id` FK; único `(round_id, provider_id)`. Request nueva
  por nueva ronda; no sobrescribir versiones/cotizaciones históricas.
- `calls.purpose`, `selected_booking_id` y `quote_request_id` según routing.
- Para llamadas outbound: `outbound_attempt` en 1..3, `dispatch_state`
  (`prepared`, `dispatching`, `accepted`, `unknown`, `failed`),
  `raw_twilio_status`, `last_callback_sequence`, `answered_at` y
  `dispatch_started_at`. Único parcial `(quote_request_id, outbound_attempt)`.
- `outbox` conserva `job_type=contact_provider`; payload enlaza `round_id`,
  `quote_request_id`, `call_id`, `attempt`. Una fila por intento con clave
  `contact-provider:<request-id>:attempt:<n>` y `available_at` para programarlo.
- Reutilizar lease/contador de Outbox solo para entrega interna; no confundirlo
  con los tres intentos telefónicos. Añadir `lock_token` si falta para CAS.
- Índices en `quote_requests(round_id,status)`, `calls(quote_request_id,raw_twilio_status)`
  y consultas de Outbox pendiente/available_at. No indexar teléfonos o prompts nuevos.

## 9. Cancelación y selección de reemplazo

En la misma transacción de `cancel_booking`: cancelar Booking y su solicitud,
conservar Operación abierta, crear la ronda replacement y candidatos/outbox,
registrar eventos/recibo. Si falla crear la ronda, no confirmar media cancelación.

La helper interna `enqueue_replacement_sourcing(booking_id, source_call_id)` es
idempotente por Booking, no una tool accesible al modelo.

Algoritmo fijo para el MVP (hasta dos candidatos):

1. Obtener ronda origen desde Booking → quote → request → round.
2. Reutilizar al otro cotizante de esa ronda que no ganó, si sigue activo y no
   rechazó el trabajo. Cotización previa no implica aprobación para esta ronda.
3. Sumar un Proveedor activo no contactado antes para esta Operación, al azar;
   persistir la elección. No volver a sortear al reintentar.
4. Excluir a proveedores que cancelaron Bookings de esta Operación y a quienes
   rechazaron explícitamente ese trabajo. No confundir request cancelada por
   adjudicación con rechazo del Proveedor: consultar evidencia de decline.
5. Si datos históricos tuvieran varios no ganadores, elegir uno con cotización
   previa de menor máximo y desempatar por fecha/ID; sumar un nuevo candidato.
6. Si falta una categoría, contactar solo los disponibles. No rellenar con el
   cancelante ni con un rechazo. Cero candidatos: ronda exhausted y revisión.

No cambiar la selección inicial ya acordada: hasta dos activos al azar. Conservar
los controles comerciales y de compatibilidad al adjudicar; no introducir nuevos
criterios de equipo únicamente en la recuperación.

Un nuevo Mandato invalida la ronda anterior y sus trabajos pendientes. La cancelación
no inventa otro Mandato. Si no hay autorización vigente o la ventana ya pasó, no
llamar ni proponer nuevas condiciones: dejar revisión humana.

El resultado de `cancel_booking` debe decir que se canceló el Booking y se inició
o agotó la búsqueda, no que ya se consiguió reemplazo. Extender su unión para
permitir `operation_status: sourcing | needs_follow_up` cuando no haya candidatos.
No anunciar correo de cancelación; `client_email_queued` sigue en `false`.

## 10. Contratos RPC para worker y callbacks

Se fijan nombres v2 para claim/finish porque cambia su firma/retorno. Retirar
permiso de ejecución de las versiones anteriores al hacer el cutover; no dejar
un camino que marque libremente y eluda los contadores.

```text
claim_next_provider_contact_v2() -> null | {
  outbox_id, call_id, lock_token,
  operation_id, round_id, quote_request_id, provider_id,
  provider_phone, purpose, attempt
}

begin_provider_contact(p_outbox_id, p_call_id, p_lock_token)
  -> { should_dial: boolean }

finish_provider_contact_v2(
  p_outbox_id, p_call_id, p_lock_token,
  p_twilio_call_sid nullable,
  p_error nullable, p_error_kind nullable /* definite | ambiguous */
) -> { dispatch_state, persisted: boolean }

record_provider_call_status(
  p_call_id uuid, p_twilio_call_sid text,
  p_status text, p_sequence integer, p_event_at timestamptz
) -> { accepted: boolean, retry_scheduled: boolean, next_attempt: integer | null }

advance_sourcing_round(p_operation_id uuid)
  -> { round_id, status, operation_status, reason }
```

Los retornos anteriores son `jsonb` escalar, no `RETURNS TABLE` ni arrays de una
fila. IDs son uuid/text según columna existente; `p_sequence` es integer y
`p_event_at` timestamptz. Supabase recibe exactamente estos nombres. El DTO del
worker usa `attempt`, la columna `calls.outbound_attempt`; hacer la conversión
solo en el repositorio, no improvisar nombres diferentes en cada consumidor.

`claim` crea/enlaza intento y adquiere lease transaccionalmente; no llama a Twilio.
`begin` vuelve a comprobar autorización, ronda activa, Mandato y presupuesto de
intentos, y hace CAS `prepared → dispatching`. Solo el worker que recibe
`should_dial=true` puede hacer el POST, una vez. Recuperar un lease no autoriza
reenviar un intento que ya pasó a dispatching.

`finish` persiste SID o fallo. No reintenta POST por error. Callback puede llegar
antes: un SID ya asociado por callback debe coincidir; finish no degrada un
estado terminal ni borra answered_at/outcome. No devolver errores de Twilio al modelo.

### Política telefónica cerrada

| Resultado | Tratamiento |
| --- | --- |
| `no-answer` y attempt < 3 | Crear siguiente intento único, disponible 60 s después del terminal. |
| `no-answer` en attempt 3 | Agotado; sin intento 4. |
| `busy`, `failed`, `canceled` | Terminal sin retry. |
| `in-progress` | Guardar answered_at; nunca retry telefónico por esa llamada. |
| `completed` | Atendió; cerrar, aunque no haya cotización. Sin retry. |
| Tool `decline_quote_request` | Rechazo comercial definitivo para esa Operación. Sin retry. |
| Error HTTP/timeout al crear llamada | Registrar fallo/ambigüedad; nunca rediscado automático. |

No-answer es el resultado observable del proveedor telefónico: Twilio puede
incluir un rechazo antes de atender. No podemos inferir intención del usuario
desde el timbrado. Un rechazo verbal de trabajo es otra señal. Buzón/IVR puede
contar como atendido; no agregar detección de contestador para este MVP.

Separar estado telefónico de resultado comercial (`calls.outcome`). Los callbacks
no pisan un resultado de escalación ni llaman «cotizado» a cualquier completed.
Conservar status original y el último resultado de dominio por separado.

### Transporte y callbacks

- StatusCallback debe incluir `?call_record_id=<calls.id>` en la URL firmada.
  Permite correlacionar incluso si el callback llega antes de persistir el SID.
- Solicitar `initiated`, `ringing`, `answered`, `completed` como parámetros
  repetidos de `StatusCallbackEvent`; answered trae `in-progress` como status.
- Validar firma con la URL pública exacta, incluido query, y AccountSid esperado.
  Request sin firma/identidad correcta no escribe nada.
- Procesar la RPC con `await` antes de responder 204. Un error transitorio de DB
  devuelve 5xx; no usar escrituras fire-and-forget con un 204 de falso éxito.
- Usar SequenceNumber por SID y transición monotónica. Callback duplicado o
  antiguo no reabre llamada ni programa otro retry. Terminal contradictorio se
  registra como anomalía, no habilita un retry. Completed ya demuestra atención
  aunque el evento answered llegue tarde.
- Solo el callback de la pierna PSTN padre programa retries; el fin de SIP no
  significa que el transportista no atendió. No modificar el endpoint de
  grabaciones ni la política de recording existente.
- Conservar ritmo de una llamada iniciada por segundo y hasta dos activas por
  Operación. Serializar claim/slot en DB; no asumir que un booleano local protege
  frente a dos procesos. Liberar slots al confirmar estado terminal real.
- `/calls/outbound` pasa por la misma cola/request/ronda o rechaza entrada sin
  ellas. No conservar el endpoint como bypass que marca fuera del presupuesto.

Twilio documenta estos estados y que los callbacks pueden llegar fuera de orden:
[Call resource, StatusCallbackEvent](https://www.twilio.com/docs/voice/api/call-resource#statuscallbackevent).
No inferir `no-answer` de «no apareció ninguna tool» ni de un timeout local.

### Crash entre POST y persistencia

No existe transacción atómica Twilio + PostgreSQL. No prometer exactly-once externo.
Priorizar no duplicar llamadas:

- Fallo antes de `begin`: se puede recuperar el trabajo preparado sin consumir
  otro intento, porque el worker todavía no tenía permiso para hacer POST.
- Caída después de `begin`: dispatching/unknown no se redespacha a ciegas.
  Recuperar con callback firmado o consulta puntual por SID conocido.
- Sin SID ni callback tras dos minutos, marcar incidencia pendiente de revisión;
  no inventar no-answer ni consumir reintentos de la persona. Mantener el bloqueo
  de rediscado de ese intento aun si llega evidencia tardía.
- Un callback tardío puede completar auditoría/correlación, pero una ronda ya
  cerrada no vuelve a abrirse ni encola llamadas nuevas.
- DB caída tras respuesta exitosa de Twilio: reintentar solo la persistencia del
  SID conocido, nunca otro POST de llamada.

## 11. Comparación, agotamiento y concurrencia

El reloj de cinco minutos corre desde `sourcing_rounds.first_dispatched_at`,
tomado de la primera aceptación de llamada por Twilio. Cola y reintentos no lo
reinician. Ronda replacement no hereda el reloj del Mandato anterior.

`prepare_sourcing_review`, sus hashes/contextos, `record_sourcing_review`,
`finalize_operation_sourcing`, estado de tools y validación de Booking deben
filtrar por la misma ronda/request vigente. Incluir `round_id` en el contexto
del review para que un hash viejo no seleccione una Cotización histórica.

Con Cotizaciones válidas: conservar criterio actual de adjudicación y el plazo
de comparación. Al adjudicar, cerrar ronda y cancelar todo trabajo pendiente de
esa ronda. Una llamada ya atendida puede terminar su conversación, pero no
guardar Cotizaciones para una ronda cerrada; retirar sus tools al refrescar.

Sin válidas: `advance_sourcing_round` detecta que todos los candidatos terminaron
y no quedan llamadas/reintentos pendientes. En replacement: exhausted →
`needs_follow_up`. Un simple vencimiento del reloj no equivale a «nadie contestó».
Cotización contraoferta con llamada terminada y sin aprobación final no mantiene
la recuperación abierta eternamente. La negociación dentro de una llamada sigue
teniendo sus límites actuales; no confundir contraofertas con reintentos telefónicos.

Para initial/renegotiation conservar reglas previas de ausencia de oferta y Booking
anterior, salvo la nueva política de reintentos telefónicos. El cierre manual por
recuperación fallida no debe cancelar otra reserva que seguía vigente.

Serializar cancelación, selección de ganador, cambio de Mandato y agotamiento con
el lock de Operación. Adoptar el mismo orden dentro de todas las RPCs (Operación
antes de ronda/request/Booking); si se necesita lock de llamada, adquirirlo de
forma consistente en comandos de voz. Leer relaciones sin lock para localizar
la Operación y volver a validarlas después de adquirir locks. No introducir
un ciclo call→operation en una ruta y operation→call en otra.

## 12. Migraciones y compatibilidad

Un solo subagente es dueño de todo el SQL nuevo. Archivos reservados, previa
verificación de que sus versiones siguen libres:

0. `20260830195000_provider_offer_event_type.sql`: agregar `quote.offered` al
   enum `domain_event_type` y hacer commit antes de usarlo en funciones/DML.
1. `20260830200000_provider_call_flow_isolation.sql`: purpose/selected Booking,
   estado inbound/outbound, selección, permisos de tools,
   recibos y guard de escalación.
2. `20260830201000_provider_sourcing_rounds.sql`: rondas, relaciones, backfill,
   registro de ofertas con round_id, cancelación→replacement, filtros de selección
   y revisión. Crear record_provider_offer después de sus columnas dependientes.
3. `20260830202000_provider_no_answer_retries.sql`: intentos/callbacks/claim v2,
   leases, contadores, agotamiento y permisos de RPCs antiguas.

Modificar funciones con `CREATE OR REPLACE` conservando firma cuando sea posible;
para firmas cambiadas usar v2. No editar migraciones históricas ni `DROP ... CASCADE`.
Preservar todos los nombres de tool ya existentes, incluido `escalate`, en el
constraint de `tool_command_receipts` al agregar los dos selectores y
`record_provider_offer`.

Reutilizar los eventos de auditoría existentes con metadata compatible de ronda
y motivo. La única ampliación de enum es `quote.offered`, necesaria para registrar
precios sin confundirlos con cotizaciones aprobadas. Actualizar `contracts/events.md`
y `contracts/schema.sql`. No crear otra taxonomía de eventos.
Si el validator de un evento cerrado no admite nuevas claves, conservar su payload
y guardar la nueva metadata en las columnas de ronda/intento y logs del worker.

Backfill sin efectos externos:

- Agrupar requests históricas por Operación/Mandato en rondas legacy coherentes.
  Rondas no actuales quedan cerradas; no encolar contactos nuevos por el backfill.
- Antes de imponer unicidad, detectar duplicados históricos y mapearlos sin
  borrar requests/quotes. Si no se pueden agrupar sin inventar procedencia,
  aislarlos en rondas históricas cerradas y reportar el caso.
- Calls históricas sin relación inequívoca con request pueden mantener vínculo
  null; ninguna de esas filas debe ser elegible para nuevo dispatch/retry.
- Las nuevas llamadas provider requieren purpose y correlación completos.
  No backfillear propósito a partir de lo que el modelo dijo en el transcript.
- Constraints/grants/RLS e índices antes de activar el nuevo worker. `NOTIFY pgrst`
  después de crear las RPCs. No incluir pruebas de migración en este trabajo.

## 13. Paquetes para subagentes y propiedad de archivos

Todos leen este plan, acuerdos y `AGENTS.md`. Máximo tres implementadores a la vez.
El coordinador congela contratos antes de delegar y es el único que integra
`server.ts` y contratos compartidos. No permitir dos dueños del mismo archivo.
No asignar un agente de QA. No crear ni ejecutar pruebas de ninguna clase.

| Paquete | Dueño / dependencia | Entrega | No tocar |
| --- | --- | --- | --- |
| P0 Contratos | Coordinador, primero | Tipos de flujo/estado/dispatch y firmas RPC definitivas. | Lógica existente de telefonía/HITL. |
| P1 SQL end to end | Agente DB, después P0 | Migraciones, constraints, ofertas, rondas, selección y retries. | TS, prompts, server, frontend. |
| P2 Tools y contexto | Agente Voz, después P0 | Estado separado, selectores, autorización TS y builders. | SQL, transporte, server, SDK runner. |
| P3 Dispatch y callbacks | Agente Telefonía, después P0 | Servicio de worker/callback y programación de retries. | SQL, prompts, server, grabaciones, handoff. |
| P4 SDK e integración | Coordinador, después P1–P3 | Wiring completo, scopes, SDK update y worker v2. | Rediseñar HITL, SDK, VAD o UI. |

Orden de trabajo:

```text
P0: contratos publicados
 ├─ P1: SQL, con sus migraciones en secuencia
 ├─ P2: tools y contexto usando los tipos publicados
 └─ P3: worker/callback usando las firmas publicadas
             ↓
P4: integrar P1/P2/P3 en server + SDK; cerrar el cambio completo
```

Las ramas pueden no estar funcionales por separado mientras dependan de otro
paquete; la entrega es el conjunto integrado, sin TODOs esenciales ni adaptadores
ficticios. No esperar a P1 para escribir P2/P3 cuando el contrato ya está fijado.

### P0 — Contratos compartidos

Crear `domain/call-flow.ts`, `domain/provider-call-state.ts` y
`domain/provider-contact-contract.ts` con los contratos de las secciones 4–10.
No crear fixtures, mocks ni un proyecto de pruebas.

El coordinador es dueño de `contracts/tools.schema.json`, contratos de eventos si
necesitan ajuste, `backend/package.json` y lockfile. P1/P2 entregan los cambios
requeridos a esos archivos como notas/parches al dueño. No agregar dependencias.
Usar interfaces nuevas sin dejar `as any`, direction opcional ni defaults
silenciosos como solución final.

Terminado cuando los nombres, DTOs, errores y RPCs están escritos de forma única
para que los tres implementadores no deban interpretar contratos distintos.

### P1 — SQL: permisos → rondas → reintentos

Orden interno obligatorio: selección/aislamiento, rondas/recovery, intentos/callbacks.
Tomar como base las últimas definiciones de cada función, no las más antiguas.
Actualizar también `contracts/schema.sql` como referencia del esquema, sin
confundirlo con el mecanismo de despliegue.

Entrega concreta:

1. Enum/evento quote.offered y RPC record_provider_offer; columns/checks de
   purpose, Booking seleccionado, ronda e intentos.
2. Estado de Proveedor separado por dirección; RPC de selección sin mutación.
   Guardar toda propuesta como evento, sin filtrar dentro/fuera ni consumir rondas.
3. Nuevos comandos de booking exigen selección, y quote exige outbound/request.
4. Guard de selección previa en escalación de Proveedor entrante; preservar el
   resto de `create_call_escalation` y la resolución de destinatario existente.
5. Cancelación crea una ronda y contactos de reemplazo en la misma transacción.
6. Claim/begin/finish/status/advance implementan las firmas congeladas.
7. Filtros por ronda en selección/juez y cierre `needs_follow_up` de replacement.
8. Backfill sin llamadas ni contactos adicionales y permisos service_role.

No incluir SQL de prueba, fixtures, seeds nuevos ni una ejecución de migraciones
contra una base compartida. Entregar migraciones forward listas para aplicar.

Terminado cuando todas las rutas SQL del plan están implementadas, incluida la
idempotencia y las transiciones; no basta crear las tablas.

### P2 — Voz: servicios, tools y contexto

Archivos propios existentes: `domain/provider-booking-service.ts`,
`domain/provider-quote-service.ts`, `domain/operation-read-service.ts`,
`tango/tools/call-tool-factory.ts`, `call-tool-session.ts`, `list-operations-tool.ts`,
`provider-booking-tool.ts`, repositorios de lectura/booking/quote y
`tango/agents/*instructions.ts`. Prefijar rutas con `backend/src/`.

Pasos:

1. Añadir las dos selector tools, que solo llaman la RPC de selección, y
   record_provider_offer para guardar cada importe antes de negociar.
2. Desacoplar el estado inbound de `ProviderQuoteService`.
3. Incorporar consulta de Bookings propios para el listado de voz.
4. Hacer que Factory construya solo la familia correcta de tools.
5. Reemplazar condicionales mezclados con la tabla de perfiles de sección 5.
6. Separar builders y proyectar campos explícitos según sección 6.
7. Retirar del bloque compartido las instrucciones de negociar precio.
8. Mantener el flujo de Cliente y los contratos públicos de sus tools.
9. Agregar la regla de registrar primera oferta y contraofertas sin pedir
   confirmación adicional, preservando aprobación explícita para create_quote.

No cambiar scripts/harnesses. No rehacer `EscalationTool` ni la transferencia.
El cambio de HITL aquí es únicamente su disponibilidad después de seleccionar.

Terminado cuando ninguna ruta inbound carga datos de cotización/topes, los
selectores persisten ambos vínculos y el flujo selected no puede elegir otro pedido.

### P3 — Telefonía: extender el worker existente

El envío Twilio, SIP, grabaciones y transferencia humana ya funcionan. Mantenerlos.
Para evitar pisar `server.ts`, mover solo el cuerpo necesario del worker a
`tango/workers/provider-contact-worker.ts` y el procesamiento de status a
`tango/telephony/provider-call-status-handler.ts`. Reutilizar `OutboundSourcingLoop`.

Pasos:

1. Consumir `claim_next_provider_contact_v2` y respetar `begin_provider_contact`.
2. Reutilizar `createTwilioOutboundCall`, agregando únicamente correlación de
   callback y eventos de status necesarios para la política de retry.
3. Persistir aceptación/fallo mediante finish v2 sin rediscado por error técnico.
4. Procesar callback a través de `record_provider_call_status`, con await.
5. Ejecutar `advance_sourcing_round` desde el ciclo existente.
6. Entregar a P4 los puntos exactos de wiring para worker y endpoint protegido.

No guardar reintentos en timers de memoria ni reiniciar contadores al reconectar.
No cambiar `EscalationHandoffCoordinator`, `OpenAIRealtimeGateway.refer`, saludo
ni recording. No crear pruebas, fake fetch ni simuladores.

Terminado cuando los tres intentos son durables, solo no-answer encola otro y
no existe un POST de rediscado por busy, corte, completed o error.

### P4 — Integración completa sobre SDK y telefonía existentes

Único dueño de `backend/src/server.ts`, `tango/telephony/inbound-routing.ts`,
`outbound-routing.ts`, `tango/supabase/call-routing.ts`,
`tango/realtime/agents-call-session.ts` y `realtime-session.ts`.

Pasos:

1. Integrar las migraciones/servicios/tipos de P1–P3 sin duplicar lógica en server.
2. Construir scope desde llamada persistida y conservar el routing de telefonía.
3. Cablear Factory y carga inicial antes de aceptar la llamada.
4. Adaptar el patrón `updateAgent` existente a los nuevos estados/builders.
5. Conectar worker v2 y callback durable; `/calls/outbound` usa la misma cola.
6. Conservar hooks de HITL, destinatario Directory, despedida y REFER intactos.
7. Agregar solo metadata direction/purpose/profile/round/attempt a logs existentes,
   sin prompts completos, topes ni teléfonos completos.
8. Actualizar imports, tipos y llamadas a RPC para que no quede un consumidor de
   la versión vieja ni un fallback que reactive tools mezcladas.
9. Mantener UI de Operations; `needs_follow_up` ya aparece sin nueva pantalla.
10. Agregar título/detalle de quote.offered al feed existente de dashboard, sin
    nueva UI; actualizar documentación y entregar resumen de archivos/migraciones.

No agregar scripts de pruebas, gates de QA ni llamadas de validación. El trabajo
termina con implementación integrada, no con una campaña para volver a probar
lo que el usuario ya verificó.

## 14. Criterios de entrega de código, sin pruebas

Estos son requisitos de implementación, no una suite ni una solicitud de ejecución:

- Tool list y contexto correctos desde `calls.accept`, no corregidos recién al
  segundo turno. Solo selected tiene escalación inbound.
- Elegir Booking/intención no cambia reserva; ejecutar exige confirmación y SQL
  comprueba pertenencia, dirección, propósito, estado y revisión.
- El runner SDK y la transferencia humana existentes se conservan; no aparecen
  nuevos agentes de voz, VAD, colas de respuestas o pasos de aprobación.
- Cancelar mantiene Operación abierta, crea ronda y contacta alternativas con
  sesiones salientes independientes, sin copiar el transcript entrante.
- Reintentos únicamente por no-answer, máximo tres intentos por request,
  persistidos, espaciados un minuto y sin duplicación por callbacks/replay.
- La nueva ronda tiene reloj/request propios y nunca adjudica una quote vieja.
- Sin reemplazo: needs_follow_up, sin más rondas ni notificación nueva.
- No queda un bypass directo de llamadas que saltee ronda o contador.
- Todas las propuestas del Proveedor se guardan como quote.offered, dentro o fuera
  de rango, antes de continuar negociando. Cotizaciones formales conservan
  quotes + quote.received para todos los veredictos; nunca solo las ganadoras.
- No se cambian negociación comercial, Cliente, emails de adjudicación ni Directory.
- No hay mocks en runtime, TODOs que impidan el recorrido ni casts que oculten
  contratos incompatibles. Reportar cualquier limitación concreta en la entrega.

No pedir otra ronda de preguntas para detalles ya fijados en este plan. Si se
encuentra un bloqueo real de implementación, el coordinador lo resuelve con el
menor cambio compatible con los acuerdos.

## 15. Activación del cambio

La activación no incluye una demo ni llamadas de validación. Las llamadas y HITL
ya fueron probadas por el usuario y se toman como base funcional.

1. Preparar el conjunto integrado y las migraciones forward. No borrar historia,
   alterar secretos ni modificar migraciones previas.
2. Para activar, pausar temporalmente dispatch y dejar terminar llamadas antiguas;
   aplicar migraciones por el mecanismo habitual y desplegar el backend compatible.
3. La documentación del repo describe despliegues de Render/Supabase desde main.
   No asumir atomicidad entre ellos ni afirmar que un push aplicó ambas partes.
4. Reanudar el worker con el backend nuevo. No dejar el anterior ejecutando RPCs
   antiguas sobre los datos nuevos ni habilitar un fallback de marcado directo.
5. No disparar llamadas, emails, push a main ni deploy durante la elaboración
   de este plan. Esos pasos pertenecen a la activación cuando esté autorizada.

Si falla la activación: detener dispatch nuevo y conservar Booking, calls, recibos
u Outbox. Resolver hacia adelante; no hacer rollback SQL destructivo ni volver a
un worker anterior incompatible. No agregar feature flags de destino humano.

## 16. Texto de asignación para cada subagente

Copiar este bloque y completar únicamente paquete y archivos propios:

```text
Implementá el paquete P<N> de docs/provider-call-flow-implementation-plan.md.
Leé AGENTS.md y los contratos P0. HITL y telefonía ya funcionan: conservarlos.
No redefinas reglas, nombres de tool/RPC, límites, permisos ni alcance.
No hagas upgrade del SDK, otro runner de voz ni otra transferencia humana.
No escribas ni ejecutes pruebas, harnesses, mocks, fixtures ni llamadas de validación.
Trabajá solo en archivos asignados. Si falta cambiar un archivo de otro dueño,
mandá el cambio concreto al coordinador y seguí con lo independiente.
Implementá el paquete completo con los contratos publicados; nada de TODOs
esenciales, implementación simulada ni as any para esconder incompatibilidades.
No toques secretos, producción, números reales, deploy ni main.
Entregá archivos cambiados, contratos consumidos/producidos, migraciones si aplican,
wiring que necesita el coordinador y limitaciones reales. No afirmes haber probado
lo que no se ejecutó: esta entrega excluye pruebas por pedido del usuario.
```

El coordinador integra P4 y entrega el recorrido completo en código, preservando
las piezas de llamadas y HITL ya verificadas por el usuario.
