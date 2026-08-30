# Super backlog de Tango — implementación delegable a Luna

Fecha de corte: 2026-08-30. Estado: código integrado localmente, no validado por
ejecución ni activado. Revisión 2 alineada con `632fc11` y ADR 0003; IDs conservados.

Objetivo: flujo integrado de Proveedores con inbound de Bookings, outbound de
Cotizaciones, propuestas observadas, replacement y reintentos durables.

Los **30 tickets activos** tienen implementación y wiring local; los **11 diferidos**
y **ACT-01/02** siguen fuera del alcance autorizado. Este registro no acredita
ejecución PostgreSQL, pruebas, despliegue ni comportamiento en llamadas reales.

## Progreso de implementación y trazabilidad

Implementadores Luna medium en paralelo, con ownership por archivo en checkout
compartido. El coordinador integró y realizó commits incrementales:
`1f04ec6` contratos; `0a6ac3c` repository; `cb038ba` routing;
`d698f6d` worker/callbacks; `7abec82` voz/tools; `43b8015` M0/MB;
`8842f95` M1/selección; `97d7333` M2/rondas/ofertas;
`944758a` guards de selección; `71c1604` M3 y wiring del servidor;
`31a1fc5` esquema de referencia. El cierre documental acompaña estos commits.

Continuación posterior al cierre documental (misma entrega, no nuevos diferidos):

- `82cfda4`: TEL-304 rechaza secuencias fuera del rango PostgreSQL integer y
  correlación duplicada en la URL del callback.
- `00405d1` y `009ddfb`: corrigen delimitadores de tres funciones y una expresión
  de referencia OP dañada en M2. Esos errores muestran que el cierre documental
  anterior no acreditaba que la migración pudiera ejecutarse. M2 sigue sin aplicar.
- `0a95428`: VO-201/BL-002 valida y proyecta respuestas outbound completas,
  incluidos estado, targets y resultados, sin propagar claves desconocidas.
- `c72fe4c`: valida respuestas inbound, exige selección para perfiles de gestión
  y reautoriza el listado con estado vigente. El lector genérico reutiliza esa
  validación y comprueba dirección/propósito de la llamada.

Solo se inspeccionó código y se ejecutó `git diff --check`; no hubo typecheck,
pruebas, ejecución SQL, migraciones remotas ni activación.

Todos los renglones siguientes significan **implementación local integrada, sin
validación por ejecución**. M0/MB/M1/M2/M3 son las cinco migraciones forward
reservadas en §6; no se aplicaron. Las rutas cortas de código parten de
`backend/src/`; las migraciones están en `supabase/migrations/`.

| Ticket | Archivo/símbolo que implementa el resultado |
| --- | --- |
| BL-001 | `domain/call-flow.ts`, `domain/provider-call-state.ts`: scope/estados discriminados. |
| BL-002 | `domain/provider-contact-contract.ts`, `docs/provider-call-contracts.md`, `contracts/tools.md`, `contracts/events.md`: RPC y schemas. |
| DB-100 | MB: `validate_booking`, `validate_booking_evidence`, puntero, adjudicación/cancelación Cliente y trigger de email; `contracts/schema.sql`. |
| DB-101 | M0 enum `quote.offered`; M1 columnas de purpose/selección/request y aislamiento. |
| DB-102 | M1: `get_provider_inbound_tool_state`, `select_provider_booking`. |
| DB-103 | M1: wrapper `execute_provider_booking_tool` y `execute_escalation_tool`, autorización antes de replay. |
| DB-104 | M2: `sourcing_rounds`, backfill cerrado, `enqueue_mandate_sourcing`, cierre de scope obsoleto. |
| DB-105 | M2: `record_provider_offer`, `execute_provider_quote_tool`, evento observado y enlace formal. |
| DB-106 | MB + M2: cancelación inmutable y `enqueue_replacement_sourcing` en transacción del evento. |
| DB-107 | M2: `prepare_sourcing_review`, `finalize_operation_sourcing`, adjudicación por ronda actual. |
| DB-108 | M3: intentos únicos, `claim_next_provider_contact_v2`, `begin_provider_contact`. |
| DB-109 | M3: `finish_provider_contact_v2`, persistencia idempotente del mismo SID. |
| DB-110 | M3: `record_provider_call_status`, secuencia, atención tardía y retry no-answer. |
| DB-111 | M3: `advance_sourcing_round`, ambigüedad/agotamiento y permisos service_role; RPC legacy revocadas. |
| VO-201 | Servicios `domain/provider-booking-service.ts`, `provider-quote-service.ts` y repositorios separados. |
| VO-202 | `tango/tools/provider-booking-tool.ts`, listado autorizado y selectores de acción. |
| VO-203 | `tango/tools/provider-quote-tool.ts`: `record_provider_offer` y resultado mínimo. |
| VO-204 | `tango/tools/call-tool-factory.ts`, `call-tool-session.ts`: familias/perfiles cerrados. |
| VO-205 | `tango/agents/provider-inbound-instructions.ts`, `provider-booking-instructions.ts`: selección y gestión inbound. |
| VO-206 | `tango/agents/provider-quote-instructions.ts`: propuesta observada antes de negociación/aprobación. |
| TEL-301 | `tango/supabase/provider-contact-repository.ts`: RPC v2 escalares con guards. |
| TEL-302 | `tango/workers/provider-contact-worker.ts`: claim/begin/POST/finish/advance sin redial técnico. |
| TEL-303 | `tango/telephony/twilio-outbound.ts`: correlación del intento y callbacks. |
| TEL-304 | `tango/telephony/provider-call-status-handler.ts`: firma, AccountSid, datos y persistencia esperada. |
| INT-401 | `tango/telephony/call-scope.ts`, routing inbound/outbound y `server.ts`: scope persistido. |
| INT-402 | `tango/realtime/agents-call-session.ts`: estado inicial antes de accept, refresh y misma sesión/updateAgent. |
| INT-403 | `server.ts`: worker v2, endpoint outbound sin marcado directo, callback await y parser form. |
| INT-404 | `tango/services/sourcing-review-service.ts`, `tango/agents/sourcing-judge.ts`, `tango/supabase/erp.ts`: ronda/puntero. |
| INT-405 | `tango/supabase/dashboard.ts`: feed `quote.offered`; metadata segura en server/worker/tools. |
| DOC-501 | Este registro y docs de worker, Bookings, Cotizaciones, tools y logs; runbook y límites explícitos. |

Recorrido integrado: incoming → `resolveCallScope` persistido → estado autorizado
→ build agent → accept; mutation → estado actualizado → `updateAgent`.
Los agentes no hicieron commits simultáneos sobre el índice compartido.

### Límites para activar

- M0→MB→M1→M2→M3 y backend deben desplegarse coordinadamente. El esquema de
  referencia no es una migración ni una alternativa para aplicar cambios.
- El baseline histórico 200000 tiene un posible bloqueo de instalación fresca
  por `UPDATE ... FROM LATERAL` que referencia el alias objetivo; ver ACT-01.
  No se alteró ni se ejecutó ese archivo.
- No hay control independiente de pausa del loop HTTP. El drenaje y la pausa
  del autodeploy Render requieren un procedimiento operativo autorizado antes
  de activar; ver [runbook](outbound-worker.md).
- No se ejecutaron tests, typecheck, harnesses, db:check, migraciones, llamadas,
  emails, push ni deploy. Los harnesses/CI históricos no se adaptaron ni se
  consideran compatibles o aprobados por esta entrega.
- `commitment_created: false` es compatibilidad deprecated; no existe entidad
  Compromiso. Evidencia completa/retención/aviso siguen en DIF-06/07/09/10/11.

## 1. Autoridad, alcance y conflictos resueltos

Leer en este orden:

1. [AGENTS.md](../AGENTS.md): restricciones del repositorio y destino humano.
2. [ADR 0003](adr/0003-bookings-inmutables-sin-compromisos.md) y
   [CONTEXT.md](../CONTEXT.md): Bookings inmutables, puntero vigente y evidencia
   perteneciente a la Llamada. Son posteriores al PLAN y prevalecen en esos temas.
3. Este backlog, revisión 2: aplica esa actualización en los tickets, contratos
   a publicar y reservas de migración. Esas correcciones prevalecen sobre el PLAN.
4. [Plan de implementación](provider-call-flow-implementation-plan.md), en adelante
   **PLAN**: fuente principal para el resto de contratos, flujos y restricciones.
5. [Acuerdos de Proveedores](provider-call-flow-design.md): intención de producto.
6. [Backlog de cierre](backlog-completion.md), en adelante **CIERRE**: cobertura
   general e historia; sus diferencias con PLAN no se ejecutan por defecto.

No ejecutar literalmente las referencias antiguas del PLAN a Bookings mutables,
Compromisos, cuatro migraciones o sus timestamps. Esta revisión corrige esos puntos
sin editar los documentos fuente. El resto del PLAN sigue vigente.

El cambio nuevo todavía contiene un puente de compatibilidad: agregar
`current_booking_id` no vuelve inmutables por sí solas las escrituras existentes.
DB-100 completa esa transición antes de las tareas de Proveedores. El backlog
anterior se conserva como historia; lo diferido no se ejecuta automáticamente.

| Tema | CIERRE | Decisión para esta entrega |
| --- | --- | --- |
| Humano sin Operación | S2 permite escalación no resuelta. | Proveedor inbound necesita Booking y acción seleccionados antes de `escalate`. No cambiar la política existente de Cliente. |
| Entrada de Proveedor | S1 plantea intención y Operación genéricas. | Solo Bookings propios confirmados; elegir reprogramar o cancelar; una gestión por llamada. |
| Recuperación | S2/S4 dejan dispatch para comando humano. | Cancelación confirmada de Proveedor crea replacement y contactos en la misma transacción. Una nota nunca lo dispara. |
| Consola de aprobación | S2 pide comandos, overrides y nueva UI. | Fuera del cambio vigente; reutilizar `needs_follow_up` y UI existente. Ver DIF-02 a DIF-04. |
| Historia de reservas | S4/S5 usan Compromisos y un Booking mutable. | ADR 0003: Bookings inmutables + Eventos; `current_booking_id` es la autoridad. No recrear Compromisos. DB-100 adapta SQL y BL-002 los contratos. |
| Evidencia | S5 usa extractos/checkpoints en Compromisos. | Booking referencia Llamada y rango real de segmentos; grabación pertenece a Llamada, no es URL pública. Completar captura/UI en DIF-06/07. |
| Conservación de llamadas | PLAN excluye cambios de grabación y saludo. | CONTEXT incorpora aviso, intentos sin interacción y retención de 90 días. DIF-09/10/11 los explicitan; necesitan alcance de implementación propio. No declararlos implementados ni descartarlos. |
| Pruebas y demo | G0/G6 exigen harnesses y llamadas. | PLAN excluye escribir/ejecutar pruebas, QA, mocks, fixtures y llamadas de validación. ACT-02 queda deshabilitado. |
| Baseline desplegado | G0 precede a todos los slices. | Primero entregar código integrado y migraciones forward; aplicar y desplegar requiere autorización separada, ACT-01. |
| Reintentos técnicos | S3 pide recuperación genérica de fallos. | Solo `no-answer` admite rediscado. Error de POST o resultado ambiguo nunca autoriza otra llamada automática. |

### Fuera de alcance de todos los tickets activos

- Cambiar modelo, SDK, voz, VAD, idioma inicial o política comercial.
- Rehacer SIP, grabaciones, HITL, despedida o coordinador de transferencia.
- Cotizar por inbound, incluido callback del Proveedor a una llamada de Tango.
- Nueva UI de aprobación, emails de cancelación/reprogramación, nuevos roles,
  marketplace, pagos, detección de contestador o framework de workflows.
- Implementar o ejecutar pruebas, harnesses, mocks, fixtures, QA o llamadas.
- Aplicar migraciones, crear seeds nuevos, acceder a producción, tocar secretos,
  enviar emails, hacer push a main o desplegar.

Excepción técnica acotada a «no cambiar Cliente/UI/emails»: DB-100 adapta las
RPCs/lectores/triggers existentes que dependían del Booking mutable, incluso si
los llama Cliente o dashboard; INT-401/404 conectan consumidores necesarios.
Se preservan sus reglas y acciones públicas: no habilita funcionalidades nuevas,
refactor general de Cliente, UI nueva ni correos por reprogramar/cancelar.

El archivo de CI existente ejecuta harnesses en PR/push. No editarlo ni desactivarlo
para esquivar la restricción: la publicación y cualquier cambio de política se
resuelven por separado. Este backlog no solicita ejecutar `db:check`, `typecheck`
ni scripts de validación. Los criterios siguientes describen código requerido,
no resultados de pruebas que se hayan realizado.

## 2. Base local observada

Inspección de archivos, no auditoría completa ni comprobación del entorno remoto:

| Evidencia | Consecuencia para las tareas |
| --- | --- |
| `ToolCallScope` en `backend/src/domain/operation-read-service.ts` no tiene dirección/propósito. | BL-001 define el contrato nuevo; VO/INT migran sus consumidores. |
| Factory construye QuoteService y luego BookingService dependiente de él. | VO-201 separa lectores; VO-204 separa familias. |
| `call-tool-session.ts` anuncia quote y escalate en inbound entry. | Reemplazar por tabla cerrada, no solo cambiar el prompt. |
| `server.ts` inserta calls y marca directamente desde worker y `/calls/outbound`. | TEL/INT deben retirar ambos caminos que eluden ronda/intento. |
| `/twilio/call-status` pierde el status concreto y escribe sin await. | TEL-304 + INT-403 conectan persistencia durable y respuesta HTTP honesta. |
| Ya existe `OutboundSourcingLoop`, transcript repository y estados de handoff. El commit eliminó `commitment-evidence.tsx`. | Reutilizar lo vigente; DIF-07 no puede asignar ni restaurar ese componente como si todavía existiera. |
| Última migración listada: `20260830200000_bookings_replace_commitments.sql`. | El timestamp 200000 del PLAN está ocupado. Las cinco migraciones de esta revisión quedan después; confirmar disponibilidad antes de crearlas. |
| La migración agrega `current_booking_id`, source call/rango de evidencia y un trigger puente; elimina `commitments`. | No está comprobada su aplicación remota. DB-100 sustituye el puente y adapta writers, validadores y unicidad. |
| RPCs de Booking/adjudicación aún hacen UPDATE de reservas; `erp.ts` infiere vigencia por status. | DB-100/103/107 e INT-401 deben adoptar puntero explícito, no dar por terminada la inmutabilidad. |
| `contracts/schema.sql`, `events.md` y tools mantienen referencias a Compromisos. | BL-002/DB-100 sincronizan contratos; no recrear la entidad para satisfacer tipos viejos. |
| Workflow `.github/workflows/migrations.yml` contiene checks/harnesses, no pasos de aplicación remota. | No afirmar que ese workflow despliega DB ni que un push aplica DB y Render atómicamente. |

Los documentos fuente y `CONTEXT.md` tenían cambios locales del usuario al corte.
Se preservan; este backlog se entrega como archivo nuevo.

## 3. Invariantes comunes: forman parte de cada ticket

I-01. Dirección y propósito salen de `calls`/trabajo durable, nunca del modelo.
Caller ID autentica, no elige intención ni Operación. Conservar comparación inbound
exacta y rechazo de números no registrados.

I-02. Inbound de Proveedor nunca consulta contexto de cotización/topes. Outbound
solo ve su pedido; IDs, revisiones, targets y competidores quedan en servidor.
El tope comercial existente solo está en el bloque privado del prompt outbound
seleccionado: el modelo sí lo ve, no debe devolverlo al interlocutor ni al log.

I-03. Seleccionar Booking + acción no cambia la reserva. Confirmar la acción real
es posterior. Si la selección ya fue inequívoca, no añadir una pregunta artificial.
Un Booking y una acción por llamada; arrepentimiento previo a confirmar cierra
sin mutar, no abre otro flujo.

I-04. SQL autoriza incluso tools de un snapshot viejo. Autenticar identidad/familia
antes de leer recibos; replay idéntico no duplica efectos y otro payload/nombre
con la misma clave produce `idempotency_conflict`. No ampliar permisos de replay
en llamadas terminadas. `stale_operation` exige refrescar y nueva confirmación.

I-05. Precio observado no es Cotización aprobada ni Booking. Registrar cada oferta
del Proveedor sin filtrar por tope ni consumir contraofertas. Aprobación final y
adjudicación siguen sus permisos existentes.

I-06. Cancelar el Booking vigente del Proveedor pone `operations.current_booking_id`
en NULL, mantiene Operación abierta y crea Evento/recuperación/recibo atómicos.
No cambia ni borra el Booking histórico; si falla la escritura no se confirma
media cancelación. Nunca readjudicar una Cotización histórica sin nueva confirmación.

I-07. Hasta tres llamadas por request/Proveedor/búsqueda, solo por `no-answer`,
separadas 60 segundos. Contador de entrega Outbox no es contador telefónico.
No usar timers de memoria como fuente de reintentos.

I-08. Reloj de comparación: cinco minutos desde primera aceptación Twilio de la
ronda. No se reinicia por retry ni se hereda al reemplazo. Dispatch ambiguo sin
SID/callback tras dos minutos queda para revisión, no se inventa `no-answer`.

I-09. Una ronda activa por Operación y un Booking vigente por `current_booking_id`,
no por consultar Bookings con status confirmed. Reprogramar/adjudicar inserta un
Booking nuevo y cambia el puntero atómicamente; el anterior no se actualiza.
Selección fija el ID vigente: si cambió el puntero, `stale_operation`, nunca
retargetear al reemplazo. Locks: Operación antes de ronda/request/Booking y posición
consistente de llamada; revalidar vínculos después de adquirirlos.

I-10. Fin de replacement sin válidas ni trabajo pendiente: `exhausted` y Operación
`needs_follow_up`; sin nueva ronda, teléfono ni notificación automática.

I-11. `handoff_recipients`/Directory siguen siendo autoridad. No teléfono hardcodeado
en server, variable `SUPERVISOR_PHONE` ni flag equivalente. Preservar destinatario
demo existente y distinción entre destino outbound argentino y caller ID inbound.
REFER aceptado no prueba `human connected`.

I-12. Migraciones forward-only; no borrar historia ni editar migraciones antiguas.
Nuevas tablas/RPCs restringidas a `service_role`, no acceso directo de
`anon`/`authenticated`. Nada de `DROP ... CASCADE`, mocks de runtime, TODO esencial,
`as any` o fallback silencioso para ocultar contratos incompatibles.

I-13. No existe entidad Compromiso en el modelo objetivo. Historia = Bookings y
Eventos; una Solicitud de cambio puede apuntar al Booking anterior. Evidencia =
`source_call_id` y extremos reales de un rango ordenado de segmentos de esa Llamada.
No copiar transcript al Booking ni inventar rango/checkpoint; la captura completa
y conservación se entregan en los diferidos correspondientes. La compatibilidad
de un campo legacy nunca autoriza recrear la tabla eliminada.

## 4. Cómo se ejecuta con Luna

### Unidad de asignación y estados

Una asignación = **un ticket activo**, con sus fuentes, archivos y dependencias.
Los paquetes P0–P4 del PLAN se conservan como carriles; no pasar P1 entero a un
agente nuevo como si fuera una tarea pequeña. Reutilizar el mismo agente por
carril cuando resulte útil, pero cerrar cada ticket con un handoff concreto.

Estados sugeridos: `pendiente` → `lista` → `en curso` → `entregada al coordinador`
→ `integrada`. `bloqueada` requiere causa y dueño. `diferida` no entra en la cola.
Ahora todos los tickets activos están pendientes salvo **BL-001, lista para asignar**.
Completar dependencias los habilita; no significa que hoy exista un bloqueo humano.

Complejidad relativa: **S** = cambio concentrado; **M** = varias piezas de una
responsabilidad; **L** = transacción/concurrencia sensible. No son horas estimadas.
Un ticket L sigue con el dueño de su carril; no repartir una misma función SQL
entre agentes simultáneos para intentar acelerarlo.

### Dueños y límites de escritura

| Carril | Dueño | Archivos reservados |
| --- | --- | --- |
| P0/P4 | Coordinador | Tipos compartidos nuevos, `domain/tool-error.ts`, `contracts/tools.schema.json`, `contracts/events.md`, `server.ts`, routing inbound/outbound, `tango/supabase/call-routing.ts`, `tango/supabase/erp.ts`, `tango/realtime/agents-call-session.ts`, `realtime-session.ts`, `tango/services/sourcing-review-service.ts`, `tango/agents/sourcing-judge.ts`, `tango/supabase/dashboard.ts`, docs. `backend/package.json`/lockfile solo si imprescindible; sin nuevas dependencias. |
| P1 | Luna SQL | Solo las cinco migraciones nuevas y `contracts/schema.sql`. Un único dueño de SQL durante todo el carril. |
| P2 | Luna Voz | Servicios/repositories de lectura, Booking y Quote; tools de Proveedor, `call-tool-factory.ts`, `call-tool-session.ts`, `list-operations-tool.ts`; builders `*instructions.ts`. No contratos compartidos ni runner. |
| P3 | Luna Telefonía | Nuevos `provider-contact-repository.ts`, `provider-contact-worker.ts`, `provider-call-status-handler.ts`; `twilio-outbound.ts`; `outbound-sourcing-loop.ts` solo si se necesita adaptar el ciclo existente. No server/routing/HITL. |

Rutas sin prefijo en esa tabla pertenecen a `backend/src/`, salvo `contracts/`,
docs y package. Archivos nuevos exactos se detallan en los tickets. Si falta uno,
solicitar al coordinador la asignación antes de editarlo. Cambios a contratos
compartidos vuelven a BL-001/002, no se resuelven con casts locales.

Máximo tres implementadores Luna simultáneos. Dentro de cada carril se trabaja
**en serie** porque los tickets comparten archivos. El coordinador congela P0,
administra contratos y después integra P4. No hay agente de QA.

### Orden de ejecución

```text
BL-001 → BL-002: contratos congelados
  ├─ DB-100 → 101 → 102 → 103 → 104 → 105 → 106 → 107 → 108 → 109 → 110 → 111
  ├─ VO-201 → 202 → 203 → 204 → 205 → 206
  └─ TEL-301 → 302 → 303 → 304
                   los tres carriles entregados
                              ↓
INT-401 → INT-402 → INT-403 → INT-404 → INT-405 → DOC-501
                              ↓
             ACT-01 solo con autorización de activación
```

Los tres carriles pueden empezar después de BL-002. VO/TEL consumen contratos
publicados aunque las RPCs todavía no existan; no necesitan mocks ni esperar al
SQL para escribir su parte. Eso no los vuelve desplegables por separado.
Si cambia una firma, el coordinador publica el ajuste y notifica consumidores.

### Contratos que BL-002 debe congelar

Firmas de selección/ofertas/worker en PLAN §§5, 6 bis y 10. El contrato de Booking
y evidencia se actualiza por ADR 0003 en BL-001/002; no copiar el DTO mutable viejo:

| RPC | Consumo y responsabilidad |
| --- | --- |
| `select_provider_booking` | Tool de selección; persiste vínculos/intención, no reserva. |
| `record_provider_offer` | Evento + recibo en una transacción; devuelve `status: recorded`. |
| `get_provider_tool_state` | Wrapper que ramifica por dirección/propósito sin mezclar resultados. |
| `execute_provider_booking_tool` | Exige selección fija, revisión y familia inbound. |
| `execute_provider_quote_tool` | Request outbound exacta; validaciones de aprobación vigentes. |
| `claim_next_provider_contact_v2` | Devuelve `null` o job escalar con `call_id`, `lock_token`, ronda, request, purpose, attempt y destino autorizado. |
| `begin_provider_contact` | CAS y revalidación; solo `should_dial: true` permite POST. |
| `finish_provider_contact_v2` | Persiste SID o error `definite`/`ambiguous`, nunca ordena rediscado. |
| `record_provider_call_status` | Status original + secuencia + retry durable idempotente. |
| `advance_sourcing_round` | Avanza/agotamiento con estado y motivo explícitos. |

Retornos worker v2: `jsonb` escalar, no arrays ni `RETURNS TABLE`. DTO `attempt`
se convierte a `calls.outbound_attempt` solo en repositorio. `calls.id` identifica
el intento; no crear además una tabla duplicada de intentos.

### Definition of done común

- Entregar implementación real de lo especificado en archivos propios, sin
  dependencias esenciales simuladas; indicar contratos pendientes de integración.
- Acompañar cada criterio con símbolo/archivo que lo implementa y explicar casos
  de error relevantes. Eso es trazabilidad de código, **no prueba de ejecución**.
- Declarar archivos cambiados, entradas/salidas, migración si aplica, wiring del
  coordinador y cualquier limitación concreta.
- No declarar probado, desplegado o funcionando en remoto algo no ejecutado.
- Un ticket entregado no equivale al slice listo: DOC-501 cierra el conjunto
  integrado. Activación y validación tienen estados independientes.

## 5. Tickets P0 — contratos previos

### BL-001 · Publicar scope y estados discriminados

- Dueño: coordinador. Complejidad M. Dependencias: ninguna. Fuente: PLAN §§4–6.
- Archivos: crear `backend/src/domain/call-flow.ts` y
  `backend/src/domain/provider-call-state.ts`.
- Implementar `CallIdentity`, `ToolCallScope`, `ProviderInboundState`,
  `ProviderOutboundState`, `ProviderCallState`, `ProviderStateReader` y DTOs
  relacionados según el PLAN; reutilizar tipos de negocio, no duplicarlos.
- Scope admite exactamente Cliente inbound/operation_management, Proveedor
  inbound/booking_management y Proveedor outbound con los tres purposes previstos.
- Aceptación: dirección/purpose obligatorios e inmutables; unión discriminada,
  targets privados, nulls fieles al dato real, `lastOffer` separado de `lastQuote`.
  Queda definido quién es dueño de cada tipo y de su export compatible anterior.
- Target de Booking incorpora el ID vigente observado y revisión de Operación;
  dejar de usar `updated_at` de una reserva mutable como autoridad de vigencia.
  Evidencia referencia Llamada/rango nullable real, nunca un Compromiso ni un extracto copiado.
- No tocar: servicios, SQL, comportamiento de Cliente ni transporte.
- Handoff: nombres/imports y DTOs definitivos para VO-201 e INT-401.

### BL-002 · Congelar DTOs RPC, schemas y errores

- Dueño: coordinador. Complejidad M. Dependencias: BL-001. Fuente: PLAN §§5–12.
- Archivos: crear `backend/src/domain/provider-contact-contract.ts`; ajustar
  `backend/src/domain/tool-error.ts`, `contracts/tools.schema.json` y
  `contracts/events.md`; registrar decisiones concretas en este documento si faltan.
- Publicar firmas exactas de selección/ofertas/claim/begin/finish/status/advance,
  discriminantes de error y resultados; sin defaults de dirección o propósito.
- Selectores: objeto cerrado con `operation_reference`, patrón `^OP-[0-9]{6,}$`.
  Offer: objeto cerrado con `price_range.min/max` positivos y ordenados, currency
  opcional. Conservar nombres/argumentos públicos de tools anteriores y `escalate`;
  sus resultados/documentación se alinean con el Booking inmutable.
- Definir `quote.offered` v1, sin tope numérico; enlace posterior desde
  `quote.received` compatible con su validación. Publicar conversión DTO/DB.
- Aceptación: DB/VO/TEL pueden escribir sin inventar nombres, errores o retornos;
  tipos cubren cancelación con `sourcing | needs_follow_up`. Fijar orden de locks
  y contrato interno del endpoint outbound: consumir trabajo durable, nunca marcar
  directo; preferir rechazo si no existe correlación válida.
- Definir resultado interno de reprogramación con Booking anterior/nuevo y puntero
  vigente; cancelación significa puntero NULL, no status mutado en historia.
  Estos IDs quedan en servidor, no se agregan como argumentos del modelo.
- Retirar `commitment_id` del envelope actual y toda promesa de crear Compromisos
  de schemas/descripciones. `commitment_created: false` puede conservarse solo
  como campo deprecated donde un consumidor vigente lo exige; documentar esa
  compatibilidad, sin ramas `true` ni significado operativo nuevo. No reescribir
  payloads históricos; un cambio de schema_version debe ser explícito.
- Publicar procedencia histórica mediante Eventos con IDs anterior/nuevo y
  Solicitud de cambio existente; no inventar `supersedes_commitment_id` ni otra
  tabla de historia. IDs de evidencia se obtienen de captura real, no del modelo.
- No tocar: runtime, SDK, dependencias, migraciones ni handlers ajenos.
- Handoff: mapa productor/consumidor y firmas a los tres carriles; P0 congelado.

## 6. Tickets P1 — SQL secuencial, un solo dueño

Reservas de archivos, que se confirman libres antes de empezar:

- **M0**: `supabase/migrations/20260830210000_provider_offer_event_type.sql`.
- **MB**: `supabase/migrations/20260830211000_immutable_booking_commands.sql`.
- **M1**: `supabase/migrations/20260830212000_provider_call_flow_isolation.sql`.
- **M2**: `supabase/migrations/20260830213000_provider_sourcing_rounds.sql`.
- **M3**: `supabase/migrations/20260830214000_provider_no_answer_retries.sql`.

Estos alias son rutas concretas, no una migración adicional por ticket. M0 agrega
el enum y debe quedar confirmado en su propia transacción antes de usarlo. Orden
de aplicación: M0 → MB → M1 → M2 → M3, después de la migración recibida 200000.
MB no depende de aislamiento/rondas/intentos; M1 no puede referenciar `round_id`
que crea M2, ni M2 columnas de intentos que crea M3. Aunque DB-100 se redacte antes
de DB-101, no se aplica aisladamente. No renombrar ni editar la migración recibida;
si presenta un bloqueo real de aplicación, reportarlo al coordinador antes de ACT-01.
El conjunto es una sola entrega de activación, no cinco despliegues independientes.

### DB-100 · Completar Bookings inmutables y autoridad del puntero vigente

- Dueño: Luna SQL. Complejidad L. Dependencias: BL-002. Fuente: ADR 0003 y CONTEXT.
- Archivos: MB, `contracts/schema.sql`. No modificar la migración 200000 recibida.
- Migrar lectores y writers SQL vigentes de selección, reprogramación, cancelación,
  renegociación y comandos ya existentes de Cliente/dashboard al puntero de Operación.
  Partir de sus últimas definiciones; no implementar acciones nuevas.
- Reprogramar: Solicitud de cambio aplicada + INSERT del Booking sucesor + Evento
  con anterior/nuevo + cambio de puntero en una transacción. Validar autorización
  actual y cambio exclusivo de retiro; no exigir que la Cotización original de una
  reserva aún vigente siga sin vencer ni debilitar validación de adjudicación nueva.
- Cancelar: Evento y NULL solo si el puntero sigue apuntando al Booking esperado;
  adjudicar: INSERT y sustitución del puntero bajo lock. Replay no inserta otro
  Booking. Fuera de Mandato no mueve puntero ni cambia datos históricos.
- Reemplazar `one_active_booking_per_operation` basado en status y el trigger
  puente `sync_current_booking` por integridad de puntero: misma Operación,
  actualización autorizada y un único vigente. Adaptar `validate_booking` y
  retirar mantenimiento de updated_at mutable; impedir UPDATE/DELETE de Bookings.
  Conservar columnas legacy como datos históricos si quitarlas no es necesario.
- Aceptación: ningún writer/lector SQL actual usa status como autoridad o modifica
  Bookings previos; incluso cancelación de Cliente conserva su regla comercial con
  escritura inmutable. Cambios posteriores DB-103/106/107 preservan esta base.
- Diferenciar INSERT por adjudicación de INSERT por reprogramación en triggers de
  email: solo adjudicación conserva sus notificaciones; reprogramar no las dispara.
  Validar source call, rango completo, misma Llamada y orden real de segmentos si
  existe evidencia; permitir ausencia honesta, no inventar datos para pasar checks.
- Actualizar referencia schema: puntero/evidencia y ausencia de entidad Compromiso;
  no DROP adicional de historia ni recreación de esa entidad. No ejecutar SQL.
- Handoff: funciones/triggers/constraints migrados, resultado P0 y consumidores TS
  que INT-401/404 deben alinear. El puente recibido no cuenta como esta entrega.

### DB-101 · Crear enum y columnas de aislamiento

- Dueño: Luna SQL. Complejidad S. Dependencias: DB-100. Fuente: PLAN §§4, 12.
- Archivos: M0, M1, `contracts/schema.sql`.
- M0 agrega únicamente `quote.offered` a `domain_event_type`. M1 agrega purpose,
  selected_booking_id y correlación request necesaria; conserva direction/intent.
- Aceptación: FK/checks compatibles con legado y contrato nuevo; recibos admiten
  los dos selectores y `record_provider_offer` sin perder `escalate` ni tools
  existentes. No usar aún columnas de ronda/attempt no creadas.
- No tocar: migraciones previas, seeds, datos remotos ni TS.
- Handoff: columnas, constraints y criterio de compatibilidad histórica.

### DB-102 · Estado autorizado y selección sin mutación

- Dueño: Luna SQL. Complejidad M. Dependencias: DB-101. Fuente: PLAN §§5–6.
- Archivos: M1, `contracts/schema.sql`.
- Implementar rama inbound de `get_provider_tool_state` y
  `select_provider_booking`; outbound conserva su aislamiento y se completa con
  la ronda en DB-104/107. Inbound no llama primero al lector de quotes.
- Validar proveedor/llamada activos, inbound/booking_management, dueño por
  Booking → quote → request → provider, referencia exacta y coincidencia con
  `operations.current_booking_id`. No listar Bookings históricos aún con status confirmed.
- Aceptación: escribe solo `calls.operation_id`, `selected_booking_id`, intención
  y recibo; nunca Booking/Mandato/change request/Outbox. Misma selección es replay;
  otra acción o Booking no sustituye la elección. Lista solo Bookings propios.
- No tocar: mutaciones de dominio, elección automática con una sola candidata.
- Handoff: payloads de entrada/selected/sin Bookings y errores a VO-201/202.

### DB-103 · Autorizar comandos y escalación por selección persistida

- Dueño: Luna SQL. Complejidad L. Dependencias: DB-102. Fuente: PLAN §5.
- Archivos: M1, `contracts/schema.sql`; completar referencias de ronda en M2
  mediante DB-107, no adelantarlas a M1.
- Adaptar últimas definiciones de `execute_provider_booking_tool`,
  `execute_provider_quote_tool` y `create_call_escalation`.
- Booking exige ID seleccionado aún igual al puntero vigente, intención exacta,
  propiedad, revisión de Operación y familia;
  referencia opcional coincide o usa vínculo, nunca selecciona. Quote exige
  outbound y `calls.quote_request_id`, no «última solicitud».
- Aceptación: reprogramación solo de retiro autorizado, cambio fuera de alcance
  deja reserva intacta y solicitud de revisión; guard de escalación no completa
  selección faltante. Snapshot viejo y cambio concurrente no mutan otro Booking.
  Autorización precede recibo; replay no crea otra transferencia.
- Reutilizar INSERT/sustitución de puntero de DB-100 al reprogramar; jamás volver
  al UPDATE del Booking de la migración 080000. Si otro comando sustituyó el
  puntero, devolver stale_operation; no cambiar el target seleccionado.
- No tocar: resolver destinatario, flujo Cliente, REFER, fabricar evidencia o
  recrear Compromisos. Preservar historia y resultado definido en BL-002.
- Handoff: guards y códigos de error al carril VO; hooks existentes de HITL intactos.

### DB-104 · Crear rondas y migrar historia sin efectos externos

- Dueño: Luna SQL. Complejidad L. Dependencias: DB-103. Fuente: PLAN §§8, 12.
- Archivos: M2, `contracts/schema.sql`.
- Crear `sourcing_rounds` con campos/checks del PLAN, FK coherentes y unicidad:
  una active por Operación, replacement por source Booking e idempotency_key.
  Asociar `quote_requests.round_id`, único por ronda/proveedor.
- Backfill coherente por Operación/Mandato; duplicados imposibles de atribuir van
  a rondas históricas cerradas sin borrar requests/quotes ni inventar procedencia.
  Calls ambiguas mantienen correlación null y no se habilitan para dispatch.
- Aceptación: initial/renegotiation nuevos crean rondas y requests propios bajo
  reglas actuales; Mandato nuevo invalida ronda/trabajo anterior. No se encolan
  contactos por el backfill. Catálogo y SQL lector pueden usar la ronda exacta.
- No tocar: intento telefónico, cambiar selección inicial de hasta dos activos al azar.
- Handoff: joins exactos a Booking/request/round y casos históricos aislados.

### DB-105 · Registrar propuestas y enlazar Cotización formal

- Dueño: Luna SQL. Complejidad M. Dependencias: DB-104. Fuente: PLAN §6 bis.
- Archivos: M2, `contracts/schema.sql`.
- Crear `record_provider_offer` con evento/recibo atómicos e identidad outbound
  de la request; guardar precio/moneda, ronda, speaker y approval definidos en P0.
- Aceptación: cada propuesta nueva crea evento aun fuera de rango; repetir una
  invocación no duplica, mismo monto con otra invocación sí puede ser otro hecho.
  Currency explícita se conserva, ausente usa la verificada; rango incomparable
  es `unassessed`. No filtrar por tope ni contraofertas restantes.
- `create_quote` mantiene versión + `quote.received` para todos sus veredictos;
  enlaza oferta por contexto servidor y, si falta, registra en esa transacción.
  Oferta sola no cambia request/Operación, adjudica, consume contraofertas ni envía email.
- No tocar: extracción regex de transcript, nuevas reglas de aceptación comercial.
- Handoff: payload real, vínculo de evento y lectura de `lastOffer` para VO-203.

### DB-106 · Cancelación y replacement atómicos

- Dueño: Luna SQL. Complejidad L. Dependencias: DB-105. Fuente: PLAN §9.
- Archivos: M2, `contracts/schema.sql`.
- Incorporar helper interna `enqueue_replacement_sourcing(booking_id, source_call_id)`
  idempotente por Booking, invocada dentro de cancelación; comprobar ID vigente,
  limpiar current_booking_id, cancelar request y registrar Evento sin actualizar
  Booking. Mantener Operación abierta, crear ronda/request/Outbox y recibo conjuntamente.
- Candidatos: otro cotizante no ganador activo y sin rechazo + un activo nuevo
  no contactado en la Operación al azar, persistido. Excluir cancelantes y rechazos
  explícitos a partir de Eventos/solicitudes, no `bookings.status = cancelled`;
  no confundir request cancelada por adjudicación con decline.
- Varios no ganadores históricos: menor máximo, luego fecha/ID. Hasta dos;
  si falta una categoría usar solo disponibles, sin rellenos prohibidos.
- Aceptación: replay no crea otra ronda; cero candidatos o falta de autorización/
  ventana vigente no dispara llamadas y deja revisión. Resultado dice búsqueda
  iniciada o agotada, nunca reemplazo conseguido; `client_email_queued: false`.
- No tocar: otro Mandato, Cotizaciones viejas, correos de cancelación, nuevas
  reglas de compatibilidad de equipo solo para recuperación.
- Handoff: formatos Outbox que M3 completa, eventos y unión de resultado a VO.

### DB-107 · Adjudicación y revisión limitadas a la ronda vigente

- Dueño: Luna SQL. Complejidad L. Dependencias: DB-106. Fuente: PLAN §§6, 11.
- Archivos: M2, `contracts/schema.sql`.
- Actualizar `prepare_sourcing_review`, hashes/contexto, `record_sourcing_review`,
  `finalize_operation_sourcing`, estado outbound y guard de Booking/quote para la
  misma ronda/request; incluir round_id en contexto que participa del hash.
- Aceptación: no gana quote histórica ni review obsoleto. Conservar selección
  comercial actual, hasta tres revisiones comerciales existentes y emails de
  adjudicación idempotentes; cerrar ronda y cancelar trabajos pendientes al ganar.
- Crear Booking nuevo y sustituir puntero con DB-100, sin cancelar/modificar la
  fila anterior. Validar vigente desde current_booking_id; nullear o sustituir
  exige la revisión esperada. Un sucesor por reprogramación no es adjudicación.
- Reloj usa primera aceptación Twilio de esa ronda. Llamadas atendidas pueden
  terminar conversación, pero no formalizar Cotizaciones de ronda cerrada.
  Initial/renegotiation conservan reglas previas, incluido Booking anterior.
- No tocar: nuevo juez, selección LLM de otra Operación ni reglas nuevas de precio.
- Handoff: contratos de revisión a INT-404 y estado outbound a VO-201.

### DB-108 · Intentos durables, claim y permiso único de marcado

- Dueño: Luna SQL. Complejidad L. Dependencias: DB-107. Fuente: PLAN §§8, 10.
- Archivos: M3, `contracts/schema.sql`.
- Añadir campos de attempt/dispatch/status/sequence/answered/started a calls e
  índices; único `(quote_request_id, outbound_attempt)` y rango 1..3. Extender
  Outbox con available_at/lock_token si hace falta; payload exacto por intento.
- Implementar `claim_next_provider_contact_v2` y `begin_provider_contact`:
  claim crea/enlaza intento + lease; begin revalida autorización/Mandato/ronda y
  hace CAS prepared → dispatching. Solo ganador recibe permiso para POST.
- Aceptación: lease recuperado no redespacha dispatching; slot/rate serializados
  en DB, hasta dos llamadas activas por Operación y no más de una iniciada por
  segundo. Entrega interna no consume otro intento telefónico.
- No tocar: tabla paralela de intentos, timers como estado durable, llamadas externas.
- Handoff: DTO escalar y semántica de lease/slot a TEL-301/302.

### DB-109 · Finish seguro ante POST ambiguo y callback adelantado

- Dueño: Luna SQL. Complejidad M. Dependencias: DB-108. Fuente: PLAN §10.
- Archivos: M3, `contracts/schema.sql`.
- Implementar `finish_provider_contact_v2` con lock token y call_id exactos;
  almacenar SID/error y clasificar definite/ambiguous sin rediscado.
- Aceptación: callback previo y finish concilian el mismo SID; nunca sobrescribe
  otro SID padre ni degrada terminal/answered/outcome. Repetir persistencia del
  SID conocido es idempotente y no crea Outbox de otra llamada.
- Conservar dispatching/unknown recuperable por evidencia, no por lease vencido;
  el tratamiento a dos minutos lo conecta DB-111.
- No tocar: considerar timeout como `no-answer`, prometer exactly-once de Twilio.
- Handoff: estados y errores de persistencia/reconciliación a TEL-302.

### DB-110 · Callback monotónico y retries exclusivos de no-answer

- Dueño: Luna SQL. Complejidad L. Dependencias: DB-109. Fuente: PLAN §10.
- Archivos: M3, `contracts/schema.sql`.
- Implementar `record_provider_call_status` con calls.id/SID, secuencia y fecha;
  preservar status telefónico separado de `calls.outcome` comercial.
- Aceptación: no-answer con attempt < 3 crea siguiente intento/Outbox únicos
  disponibles 60 s después del terminal; tercero no crea cuarto. Busy, failed,
  canceled, completed, answered y decline no autorizan retry.
- In-progress guarda answered_at; completed demuestra atención aunque answered
  llegue tarde. Duplicados/antiguos no reabren; terminal contradictorio registra
  anomalía sin rediscado. Liberar slots con terminal real, no fin de SIP.
- Ronda cerrada o request invalidada nunca encola contacto por callback tardío.
- No tocar: resultado de escalación, inferir rechazo verbal desde timbrado.
- Handoff: retornos accepted/retry_scheduled/next_attempt a TEL-304.

### DB-111 · Agotamiento, permisos y cierre del conjunto SQL

- Dueño: Luna SQL. Complejidad L. Dependencias: DB-110. Fuente: PLAN §§10–12.
- Archivos: M3 y `contracts/schema.sql`; ajustes finales a M0, MB, M1 y M2 solo antes de
  publicarlas/aplicarlas y conservando secuencia de dependencias.
- Implementar `advance_sourcing_round`: sin válidas, todos terminales y sin
  trabajo/retry pendiente, replacement pasa a exhausted/needs_follow_up. Una
  contraoferta sin aprobación con llamada terminada no lo mantiene abierto siempre.
- Resolver dispatch ambiguo sin SID/callback tras dos minutos como incidencia
  de revisión sin liberar permiso de rediscado. Evidencia tardía audita, no reabre.
- Aceptación: timeout de comparación no inventa agotamiento con llamadas pendientes;
  initial/renegotiation mantienen semántica previa. Operación/locks evitan carreras
  con cancelación, Mandato o ganador. No se cancela otro Booking aún vigente.
- Completar grants/RLS/índices, revocar ejecución de claim/finish anteriores en
  cutover, `NOTIFY pgrst`, referencia schema coherente con todas las RPCs nuevas.
- No tocar: ejecutar migraciones ni agregar SQL de prueba o taxonomy de eventos nueva.
- Handoff: cinco migraciones completas en orden, permisos, compatibilidad histórica
  y limitaciones a coordinador. No basta entregar tablas sin cuerpos de RPC.

## 7. Tickets P2 — servicios, tools y contexto

### VO-201 · Separar estado de Bookings y de Cotizaciones

- Dueño: Luna Voz. Complejidad M. Dependencias: BL-002. Fuente: PLAN §6.
- Archivos: `backend/src/domain/provider-booking-service.ts`,
  `provider-quote-service.ts`, `operation-read-service.ts` en el mismo directorio;
  `backend/src/tango/supabase/provider-booking-repository.ts`,
  `provider-quote-repository.ts`, `operation-read-repository.ts`.
- BookingService obtiene su propio estado inbound; QuoteService solo outbound.
  Ambos implementan `ProviderStateReader`; eliminar callback de estado quote
  usado para conocer Bookings. Export compatible de Scope apunta a BL-001.
- Aceptación: consumidores usan unión discriminada; lectura nunca combina ambos
  DTOs ni selecciona «último pedido». Targets y revisiones quedan privados;
  perfiles respetan estado real y ausencia de datos. Errores usan catálogo P0.
- Vigencia por current_booking_id, no por status histórico; resultados consumen
  el contrato inmutable de BL-002. No interpretar `commitment_created` deprecated
  como una entidad existente ni usarlo para determinar si hay Booking nuevo.
- No tocar: SQL, contratos compartidos, lector genérico de dashboard ni Cliente.
- Handoff: constructores/interfaz para VO-204; contrato SQL consumido pendiente DB.

### VO-202 · Listar Bookings y seleccionar acción explícita

- Dueño: Luna Voz. Complejidad M. Dependencias: VO-201. Fuente: PLAN §§5–6.
- Archivos: servicios/repositorios de VO-201;
  `backend/src/tango/tools/list-operations-tool.ts`, `provider-booking-tool.ts`.
- Agregar `select_booking_for_reschedule` y `select_booking_for_cancellation`;
  ambas invocan RPC única con acción derivada del nombre, no parámetro libre.
- Listado `list_provider_operations` conserva nombre y devuelve referencia,
  origen/destino/retiro real de Bookings propios vigentes por puntero; no exigir peso o
  contenedor ausentes. Consulta dedicada de voz si antes era compartida.
- Aceptación: schemas cerrados, nada de UUIDs del modelo; seleccionar no muta
  reserva. Mutaciones conservan argumentos actuales y target seleccionado;
  referencia contradictoria se rechaza, omitida usa selección, no otra candidata.
- No tocar: confirmación artificial para guardar selección inequívoca, herramientas
  para cambiar de acción ni UI.
- Handoff: tools y errores disponibles para tabla de perfiles VO-204.

### VO-203 · Tool de registro de cada propuesta de precio

- Dueño: Luna Voz. Complejidad M. Dependencias: VO-202. Fuente: PLAN §6 bis.
- Archivos: `backend/src/tango/tools/provider-quote-tool.ts`,
  `backend/src/domain/provider-quote-service.ts`,
  `backend/src/tango/supabase/provider-quote-repository.ts`.
- Agregar `record_provider_offer` outbound con schema de BL-002, RPC real y
  recibo por toolCallId. Leer `lastOffer` propio por request sin exponer IDs/topes.
- Aceptación: importes claros positivos, min <= max y moneda explícita preservada;
  si no se dijo usa moneda verificada. Error de registro no se presenta como éxito
  ni autoriza continuar negociación; repetir escritura mantiene misma clave.
- No tocar: pedir confirmación para registrar, deduplicar por monto, consumir
  contraofertas comerciales ni producir Cotización elegible desde esta tool.
- Handoff: tool y resultado registrados para VO-204/206, sin nuevo runner.

### VO-204 · Factory por familia y tabla cerrada de perfiles

- Dueño: Luna Voz. Complejidad M. Dependencias: VO-203. Fuente: PLAN §§5–7.
- Archivos: `backend/src/tango/tools/call-tool-factory.ts`, `call-tool-session.ts`.
- Instanciar solo servicios/tools de la familia autorizada; usar interfaz mínima
  de estado y tabla exhaustiva. Conservar mecanismo de replay autorizado por SQL.
- Aceptación por perfil:
  - Entry: listado + dos selectores; sin Bookings, solo listado.
  - Reschedule: reschedule + escalate. Cancel: cancel + escalate.
  - Booking escalation: solo escalate. Quote: offer + create + decline + escalate.
  - Unavailable/terminal: ninguna. No fallback genérico con permisos ampliados.
- Después de selección no quedan listado/selectores; refresh preserva intención y
  no expone otros pedidos. Metadata de logs sigue rama discriminada sin topes.
- No tocar: Cliente, SDK, transferencia o disfrazar ausencia de servicio como modo permisivo.
- Handoff: carga inicial/refresh/definitions para INT-402.

### VO-205 · Builder inbound con contexto mínimo y cierre de gestión

- Dueño: Luna Voz. Complejidad M. Dependencias: VO-204. Fuente: PLAN §§5–6.
- Archivos: crear `backend/src/tango/agents/provider-inbound-instructions.ts`;
  adaptar `provider-booking-instructions.ts` y `routing-instructions.ts`.
- Proyectar por allowlist entry/selected/terminal; nombre visible, referencias,
  trayecto/retiro y resultado real, sin catálogo duplicado desde routing.
- Aceptación: entrada pregunta intención; humano al inicio requiere Booking/acción;
  modificar recoge propuesta, resume y pide confirmación antes de ejecutar.
  Fuera de Mandato recibe applied/requires_escalation sin ventanas privadas.
- Stale exige nueva confirmación; arrepentimiento cierra sin mutar. Cancelación
  comunica búsqueda iniciada/agotada, no reemplazo logrado ni email inexistente.
- Routing compartido conserva rol/idioma/fecha/estilo/seguridad; retirar negociación
  y pasos comerciales comunes. No `JSON.stringify(state)` ni borrar historial.
- No tocar: SDK, VAD, saludo telefónico existente, builder/contratos de Cliente.
- Handoff: builder y DTO exactos para INT-402; reglas comerciales pasan a VO-206.

### VO-206 · Builder outbound y secuencia propuesta → negociación → aprobación

- Dueño: Luna Voz. Complejidad M. Dependencias: VO-205. Fuente: PLAN §§6–7.
- Archivos: crear `backend/src/tango/agents/provider-outbound-instructions.ts`;
  adaptar `provider-quote-instructions.ts` y routing solo en su composición.
- Un solo pedido con moneda/ventana verificadas, estado de negociación propia y
  contraofertas restantes; bloque privado del límite solo para esa Operación.
- Aceptación: ante precio claro del Proveedor registrar antes de contraofertar;
  no preámbulo/confirmación por registro. Corrección genera nuevo registro, oferta
  de Tango nunca se atribuye al Proveedor. Audio ambiguo se aclara, no se inventa.
- Aprobación verbal final precede create_quote; refrescar no repite pregunta o
  contraoferta inicial ya respondida. No otros pedidos, Bookings, competidores ni
  transcript inbound en la sesión outbound. Conservar política comercial existente.
- No tocar: extraer oferta con regex/modelo nuevo, nuevo SDK o moneda convertida.
- Handoff: carril VO completo y firmas de builders/factory al coordinador.

## 8. Tickets P3 — telefonía y worker existentes

### TEL-301 · Repositorio tipado de contacto y ciclo de ronda

- Dueño: Luna Telefonía. Complejidad S. Dependencias: BL-002. Fuente: PLAN §10.
- Archivos: crear `backend/src/tango/supabase/provider-contact-repository.ts`.
- Encapsular claim v2, begin, finish v2, record status y advance con nombres de
  parámetros P0, `await`, errores explícitos y retornos escalares.
- Aceptación: nunca `data?.[0]` para v2; null claim no es error; conversión attempt
  es única y scope/request/ronda provienen de DB. No casts que escondan DTO incompatible.
- No tocar: SQL, POST Twilio, server ni lógica duplicada de elegibilidad.
- Handoff: interfaz repositorio real para TEL-302/304, disponible sin mock de DB.

### TEL-302 · Extraer worker y respetar permiso de marcado

- Dueño: Luna Telefonía. Complejidad M. Dependencias: TEL-301. Fuente: PLAN §§10, 13 P3.
- Archivos: crear `backend/src/tango/workers/provider-contact-worker.ts`;
  reutilizar `outbound-sourcing-loop.ts` y servicio de revisión existente mediante
  sus dependencias, sin editar `server.ts`.
- Tras claim, begin; POST solo con should_dial true usando calls.id ya persistido,
  nunca insertando otro call desde TS. Finish guarda SID/error. Llamar advance
  desde el ciclo existente y preservar finalización comercial.
- Aceptación: fallo DB tras Twilio reintenta persistir SID, no otro POST; dispatch
  ambiguo no se redespacha. Slot/ritmo dependen de DB, no booleano del proceso.
  Poll existente puede continuar; reintentos telefónicos salen de available_at.
- No tocar: nuevo framework/loop paralelo, grabaciones, llamadas reales ni server.
- Handoff: constructor/runOnce y puntos de extracción/eliminación para INT-403;
  recuperación durable y logs sin error Twilio hacia el modelo.

### TEL-303 · Extender callback de Twilio sin cambiar SIP

- Dueño: Luna Telefonía. Complejidad S. Dependencias: TEL-302. Fuente: PLAN §10.
- Archivos: `backend/src/tango/telephony/twilio-outbound.ts`.
- Reutilizar `createTwilioOutboundCall`; callback URL incluye
  `?call_record_id=<calls.id>` y parámetros repetidos `StatusCallbackEvent`:
  initiated, ringing, answered, completed. Añadir purpose booking_replacement.
- Aceptación: correlación disponible antes de finish; `answered` del evento no se
  confunde con status `in-progress`. Mantener SIP/phoneType/destino outbound y
  SID padre. No nuevas consultas/piernas para reconstruir telefonía.
- No tocar: recording callback, caller ID inbound, marcado arbitrario ni handoff.
- Handoff: formato de URL/body y campos existentes que TEL-304 necesita validar.

### TEL-304 · Procesar status firmado y responder después de persistir

- Dueño: Luna Telefonía. Complejidad M. Dependencias: TEL-303. Fuente: PLAN §10.
- Archivos: crear `backend/src/tango/telephony/provider-call-status-handler.ts`.
- Recibir URL pública exacta incluido query, firma, AccountSid esperado y body;
  validar correlación/status/SequenceNumber/fecha según contrato, luego RPC await.
  La correlación pertenece a la pierna PSTN padre; DB concilia SID incluso temprano.
- Aceptación: firma/identidad incorrecta no escribe; entrada malformada se rechaza;
  transitorio DB devuelve 5xx, solo persistencia/duplicado reconocido permite 204.
  No fallback que invente `no-answer`, secuencia o éxito ante campos inválidos.
- Duplicados/fuera de orden se delegan al estado monotónico SQL; fin de SIP no
  programa retries. No mapear todo status a completed/failed ni pisar escalación.
- No tocar: server, recording-status, SDK, secrets ni respuestas fire-and-forget.
- Handoff: handler y requisitos de endpoint al coordinador; carril TEL entregado.

## 9. Tickets P4 — integración por el coordinador

P4 comienza tras DB-111, VO-206 y TEL-304. Solo el coordinador toca server y runner.

### INT-401 · Construir scope desde routing y correlación persistida

- Dueño: coordinador. Complejidad M. Dependencias: DB-111, VO-206, TEL-304.
  Fuente: PLAN §4, §13 P4.
- Archivos: `backend/src/server.ts`, `tango/telephony/inbound-routing.ts`,
  `outbound-routing.ts`, `tango/supabase/call-routing.ts` y `tango/supabase/erp.ts`
  bajo `backend/src/`.
- Interpretar header X-Tango-Call-Id: ausente permite circuito inbound por caller
  ID; presente vacío, inválido, desconocido o duplicado contradictorio rechaza,
  nunca fallback. Realtime incoming no redefine dirección de negocio.
- Aceptación: outbound obtiene operation/provider/request/ronda/purpose de fila
  durable y valida activos/vigentes; bind Realtime una vez, mismo ID idempotente,
  ID distinto rechazado. persistRoutedCall no crea inbound para reparar outbound.
- Scope incluye correlación correcta sin nueva sesión/registry/pierna SIP;
  dirección, propósito e intención persistidos se conservan.
- Adaptar lecturas ERP de Bookings al puntero de Operación; sus filas históricas
  no son gestiones disponibles. Eliminar catálogo mixto de contexto de Proveedor
  desde routing en favor de VO-205/206. Mantener contrato de identidad de Cliente.
- No tocar: teléfono del supervisor ni normalizar caller ID inbound con el 9.
- Handoff: scope real hacia Factory y carga inicial de INT-402.

### INT-402 · Conectar perfiles al ciclo SDK sin cambiar el runner

- Dueño: coordinador. Complejidad M. Dependencias: INT-401. Fuente: PLAN §7.
- Archivos: `backend/src/tango/realtime/agents-call-session.ts`,
  `realtime-session.ts` y wiring necesario en `backend/src/server.ts`.
- Estado correcto antes de calls.accept; initialConfiguration/connect comparten
  agente/opciones. Tool → escritura → refresh → actualizar tools/instructions →
  await updateAgent → resultado normal para continuación del SDK.
- Aceptación: misma RealtimeSession/RealtimeAgent/transport; preservar parche de
  `tools: []`, wrappers por nombre, schemas cerrados, parallelToolCalls false,
  historyStoreAudio false y tracingDisabled true. Sin nuevo response.create.
- Fallo de refresh después de commit conserva éxito, retira tools y cierra seguro;
  fallo de configuración no continúa con permisos viejos. Diagnósticos session.updated
  existentes, sin barrera ACK inventada ni updateHistory para borrar contexto.
- Handoff humano conserva backgroundResult solo para escalación preparada,
  despedida única/audio detenido/REFER; no agent_handoff como conexión humana.
- No tocar: versión 0.17.0 auditada en PLAN, VAD, colas internas o aprobación nueva.
- Handoff: conexión completa de selección, mutaciones y cierre con autorización SQL.

### INT-403 · Conectar worker v2 y eliminar bypass de marcado

- Dueño: coordinador. Complejidad M. Dependencias: INT-402. Fuente: PLAN §10.
- Archivos: `backend/src/server.ts`; cambios fuera de propiedad vuelven a TEL.
- Sustituir cuerpo inline por worker/repository TEL; endpoint call-status usa
  handler durable con await. Retirar inserciones calls/direct writes viejas y
  consumidores runtime de claim/finish anteriores.
- `/calls/outbound` mantiene autenticación y usa cola/request/ronda del contrato
  BL-002; rechaza si no existen. No teléfono libre, POST directo ni presupuesto aparte.
- Aceptación: todo marcado de sourcing requiere begin/CAS e intento persistido;
  callbacks no responden falso éxito; el ciclo ejecuta advance además de review.
  Conserva endpoints recording y hooks HITL existentes.
- No tocar: RPC legacy como fallback, disparar worker en remoto ni probar llamadas.
- Handoff: un solo camino de dispatch y lista de consumidores antiguos retirados.

### INT-404 · Alinear consumidores TS de revisión y adjudicación

- Dueño: coordinador. Complejidad M. Dependencias: INT-403. Fuente: PLAN §11.
- Archivos: `backend/src/tango/services/sourcing-review-service.ts`,
  `backend/src/tango/agents/sourcing-judge.ts` y tipos compartidos solo si P0 lo requiere.
- Consumir contexto/hash con round_id y finalización/agotamiento de DB; mantener
  contrato de selección existente y estados diferenciados, no nuevo juez.
- Aceptación: ningún consumidor combina quotes entre rondas o confunde intentos
  de teléfono con revisiones de precio. Ganador cierra pendientes de su ronda;
  initial/renegotiation conservan reserva previa según reglas existentes.
- Emails de adjudicación siguen outbox actual e idempotencia; no duplicar por
  retry/replay ni agregar eventos de entrega sin confirmación del servicio.
- Consumir resultado de INSERT/puntero y contratos sin entidad Compromiso; no
  asumir que todos los INSERT de Bookings son adjudicaciones. SQL DB-100 distingue
  reprogramación y adjudicación para no enviar emails adicionales.
- No tocar: negociación, elección por inferencia del modelo ni email worker/templates.
- Handoff: recorrido mandato → ronda → quotes → booking conectado con replacement.

### INT-405 · Mostrar propuestas en feed y metadata segura

- Dueño: coordinador. Complejidad S. Dependencias: INT-404. Fuente: PLAN §§6 bis, 13 P4.
- Archivos: `backend/src/tango/supabase/dashboard.ts`, `backend/src/server.ts`.
  Ajustes en logs de VO/TEL se solicitan a su dueño, no edición concurrente.
- Añadir título/detalle en inglés para `quote.offered`: monto, moneda y
  within/outside/unassessed; mostrar todas, no solo ofertas elegibles/ganadoras.
- Aceptación: `needs_follow_up` reutiliza Operations; no nueva pantalla ni filtros
  que oculten propuestas fuera de rango. Metadata direction/purpose/profile/round/
  attempt en logs existentes, sin prompt completo, límite privado ni teléfonos completos.
- Distinguir dial aceptado, atendido, oferta registrada, quote formal y Booking;
  no elevar REFER a humano conectado o aceptación API de email a entrega.
- No tocar: frontend, nuevas visualizaciones, evidencia ficticia ni transcript crudo en logs.
- Handoff: eventos visibles por DTO existente y metadata de diagnóstico documentada.

## 10. Cierre de implementación

### DOC-501 · Entregar conjunto integrado y runbook de activación

- Dueño: coordinador. Complejidad M. Dependencias: INT-405.
  Fuente: PLAN §§12–16; adaptación de CIERRE G0 sin ejecución externa.
- Archivos: `docs/super-backlog.md`, `docs/outbound-worker.md`,
  `docs/provider-booking-changes.md`, `docs/provider-quote-flow.md`,
  `docs/tools-implementation-status.md`, `docs/runtime-logs.md`; otros documentos
  solo si contradicen directamente los cambios y se declara su necesidad.
- Registrar tickets integrados, archivos/migraciones, contratos producidos y
  consumidos, wiring y limitaciones; no sobrescribir acuerdos de producto del usuario.
- Aceptación documental: los seis slices de la sección 11 tienen todos sus tickets
  integrados; no consumidores runtime de DTO viejo, RPC legacy ni fallback mixto.
  Prompts/docs no prometen cotizar inbound o email de cancelación. No TODO esencial.
- DB-100 y su integración son obligatorios: historia inmutable, readers por puntero,
  writers adaptados y contratos sin entidad Compromiso. Registrar por separado los
  campos deprecated preservados; no afirmar que el commit 632fc11 ya resolvía esto.
- Conservar en documentación la precedencia ADR 0003/CONTEXT/revisión 2 frente a
  los pasajes históricos del PLAN; retirar referencias operativas al componente
  eliminado y a timestamps antiguos. Evidencia pendiente DIF-06/07/09/10/11 queda
  explícita, no como capacidad disponible ni como requisito olvidado.
- Documentar pausa dispatch, drenaje llamadas, aplicación versionada DB, backend
  compatible y reanudación; identificar mecanismo real de despliegue sin afirmar
  que main o el workflow observado hacen ambas cosas atómicamente.
- CI/scripts históricos que queden incompatibles se reportan como limitación, no
  se editan ni ejecutan en secreto. No declarar validación realizada.
- No tocar: pruebas, aplicación de migraciones, push, deploy, secretos, llamadas
  ni refactor de CONTEXT.md como parte del cierre de implementación.
- Handoff final: «código integrado, no validado por ejecución ni activado» y
  lista de decisiones/permisos necesarios para ACT-01, si el usuario desea activarlo.

## 11. Slices visibles y trazabilidad

Los carriles técnicos no reemplazan las conductas verticales. Estas agrupaciones
permiten saber qué resultado queda conectado al integrar; ninguna se declara
validada en runtime por completar tickets.
DB-100 es base común de los slices que leen o escriben Bookings (SV-1/2/4/6),
además de las dependencias transitivas del carril SQL.

| Slice visible | Tickets que lo cierran | Fuente |
| --- | --- | --- |
| SV-1 · Proveedor llama y elige un Booking sin mutarlo | BL-001/002, DB-101/102/103, VO-201/202/204/205, INT-401/402 | CIERRE S1, PLAN §§4–6. |
| SV-2 · Reprogramar autorizado o escalar después de elegir | DB-103, VO-202/204/205, INT-401/402 | CIERRE S2/S4, acotados por PLAN §§1, 5, 7. |
| SV-3 · Toda propuesta outbound queda registrada | DB-104/105/107, VO-201/203/204/206, INT-401/402/405 | CIERRE S3/S5, PLAN §6 bis. |
| SV-4 · Cancelar Booking crea búsqueda nueva sin cerrar Operación | DB-104/106/107, VO-202/204/205, TEL-301/302/303, INT-401/402/403/404 | CIERRE S4, PLAN §§8–11. |
| SV-5 · No-answer reintenta de forma durable sin duplicar marcado | DB-108/109/110, TEL-301/302/303/304, INT-401/403 | CIERRE S3, PLAN §10. |
| SV-6 · Nueva ronda adjudica o termina en revisión | DB-104/107/111, TEL-302, INT-403/404/405 | CIERRE S3/S4, PLAN §11. |

| Cobertura completa del PLAN | Tickets |
| --- | --- |
| §§1–3: límites y arquitectura | Secciones 1–4 de este backlog, todos los tickets. |
| §4: identidad y routing | BL-001, DB-101, INT-401. |
| §5: selección, perfiles, guards, replay | BL-002, DB-102/103, VO-202/204, INT-402. |
| §6: estado y contexto | BL-001, DB-102/107, VO-201/205/206. |
| §6 bis: propuestas/eventos | BL-002, DB-105, VO-203/206, INT-405. |
| §7: SDK/HITL preservado | INT-402. |
| §8: persistencia | DB-101/104/108. |
| §9: cancelación/reemplazo | DB-106, VO-202/205, INT-403. |
| §10: dispatch, callbacks, crash, retry | BL-002, DB-108/109/110/111, TEL-301–304, INT-403. |
| §11: juez, agotamiento y concurrencia | DB-104/107/111, INT-404. |
| §12: migraciones, backfill y seguridad | DB-101–111, DOC-501. |
| §13: paquetes y propiedad | Sección 4, todos los carriles. |
| §14: entrega de código | Definition of done común, DOC-501. |
| §15: activación | DOC-501, ACT-01 deshabilitado hasta autorización. |
| §16: asignación | Sección 14 de este backlog. |

| Actualización posterior al PLAN | Tickets |
| --- | --- |
| ADR 0003: historia inmutable y puntero vigente | BL-001/002, DB-100/102/103/106/107, VO-201/202, INT-401/404, DOC-501. |
| Contratos y versiones de migración posteriores a 632fc11 | BL-002, DB-100/101/111, DOC-501, ACT-01. |
| Llamada propietaria de transcript/audio y Booking con rango de evidencia | DB-100 (integridad sin evidencia fabricada), DIF-06/07 (captura y consulta completas). |
| Aviso, intento sin interacción y retención de 90 días | DIF-09/10/11; alcance propio pendiente, no ejecutarlos junto a los carriles activos. |

## 12. Pendientes de cierre diferidos — no asignar junto al MVP

Son trabajo fuera de la tanda activa. DIF-09/10/11 registran requisitos ya definidos
en CONTEXT: no son ideas opcionales ni una política de retención legal inferida.
Lo pendiente es habilitar su implementación y concretar contratos técnicos donde
el glosario no los fija. No cambian por sí solos la prohibición de tocar grabaciones.
La presencia de código previo no demuestra
que estén completos ni que falten íntegros. Al habilitar uno, primero se contrasta
su brecha actual y se convierte en slice acotado con dueño/archivos definitivos.
Sus criterios son objetivos futuros, no permiso para probar o desplegar ahora.

### DIF-01 · Contexto inbound determinista de Cliente

- Estado: diferida; autorización de ampliar flujo Cliente. Fuente: CIERRE S1.
- Resultado futuro: identidad, intención y Operación no resuelta separadas;
  confirmación inequívoca con cero/una/varias candidatas antes de mutar.
- Punto de entrada: `backend/src/domain/client-operation-service.ts`,
  `tango/supabase/client-operation-repository.ts`, `tango/tools/call-tool-session.ts`.
- Dependencia: DOC-501 y nuevo alcance aprobado. Aceptación futura: ninguna
  operación inferida para una mutación; desconocidos rechazados; sin verificación vocal nueva.
- Exclusión: no usar este ticket para debilitar la selección obligatoria de Proveedor.

### DIF-02 · Escalaciones no resueltas donde la política las permita

- Estado: diferida; decisión de alcance por persona. Fuente: CIERRE S2.
- Resultado futuro: registrar solicitud humana ligada a llamada aun sin Operación
  únicamente para las personas/casos aprobados. No habilitarlo para Proveedor
  inbound salvo cambio explícito del PLAN.
- Punto de entrada: `backend/src/domain/escalation-service.ts`,
  `tango/supabase/escalation-repository.ts`, `frontend/src/app/dashboard/escalations/page.tsx`.
- Dependencia: política confirmada y DOC-501. Aceptación futura: evidencia/identidad
  propias, sin Operación inventada; mutaciones siguen requiriendo target exacto.
- Exclusión: no rehacer HITL ni probarlo de nuevo automáticamente.

### DIF-03 · Decisiones de operador auditables en consola

- Estado: diferida; UI y comandos nuevos excluidos del PLAN. Fuente: CIERRE S2.
- Resultado futuro: nota, aprobar/rechazar change request, cancelar Booking y
  aprobar excepción con actor_user_id, motivo, timestamp, before/after y revisión.
- Punto de entrada: `backend/src/http/routes/dashboard.ts`,
  `tango/supabase/dashboard-console.ts`,
  `frontend/src/features/operation/escalation-resolution-form.tsx`.
- Dependencia: alcance aprobado y contrato de cada comando. Aceptación futura:
  usuario autenticado de demo puede actuar, retries idempotentes y concurrencia
  segura; override es decisión humana, nunca aceptación atribuida al Proveedor.
- Escribir un Booking nuevo/cambiar puntero o dejarlo NULL según comando; no
  actualizar filas históricas ni fabricar source_call/rango para acciones humanas.
- Exclusión: nota no dispara automatización; no roles finos ni nueva negociación.

### DIF-04 · Reemplazo solicitado por operador mediante comando durable

- Estado: diferida; disparador manual adicional. Fuente: CIERRE S2/S4.
- Resultado futuro: `Request replacement sourcing` reutiliza infraestructura de
  ronda actual bajo autorización explícita, sin dispararse desde texto libre.
- Punto de entrada: comandos dashboard de DIF-03 y helpers SQL de DB-106.
- Dependencia: DOC-501 + DIF-03 + definir qué ocurre con Booking aún vigente y
  una ronda ya activa; no aplicar ciegamente la helper de cancelación.
- Aceptación futura: actor/motivo/idempotencia y estado conservado; no recuperación
  duplicada ni reemplazo de la automatización de cancelación ya implementada.

### DIF-05 · Separar evidencia literal, contexto verificado y decisión necesaria

- Estado: diferida; consolidación de consola. Fuente: CIERRE S2/S5.
- Resultado futuro: mostrar `Caller said`, `Verified system context` y
  `Operator decision needed` con procedencia explícita y acciones en inglés.
- Punto de entrada: `backend/src/tango/supabase/dashboard.ts`,
  `frontend/src/features/operation/handoff-overlay.tsx`, `operation-trace.tsx`.
- Dependencia: contrato de evidencia y revisión de lo ya implementado. Aceptación
  futura: extractos literales conservan idioma original; resumen del modelo no se
  etiqueta como hecho; transfer requested/failed no se confunden con human connected.
- Exclusión: ninguna promesa de conexión humana sin señal que la demuestre.

### DIF-06 · Completar persistencia/correlación de transcripciones y grabaciones

- Estado: diferida; no tocar recording en entrega activa. Fuente: CIERRE S5.
- Resultado futuro: persistencia durable de segmentos caller/Tango y callbacks
  de grabación correlacionados e idempotentes, aprovechando piezas existentes.
- Punto de entrada: `backend/src/tango/supabase/call-transcript-repository.ts`,
  `backend/src/server.ts` en recording-status y captura Realtime existente.
- Dependencia: autorización específica. Aceptación futura: escritura de recording
  no se pierde por falta de await; ausencias/errores no afirman evidencia guardada;
  correlación verificable a llamada sin reconstruir audio inexistente.
- Transcript completo y ordenado de toda Llamada operativa aunque no produzca
  Booking; IDs de segmento estables, secuencia real y deduplicación por evento,
  no solo extractos. Grabación identificada por referencia Twilio y estado en
  Llamada; no adoptar RecordingUrl pública como contrato final de evidencia.
- Coordinar con DIF-09/10/11: primero definir marcadores de aviso/operación,
  retención y disposición de evidencia, luego cerrar el contrato de captura.
- Exclusión: cambiar SIP/recording como efecto colateral de retries o guardar más
  datos sensibles de los necesarios. No ejecución externa implícita.

### DIF-07 · Evidencia de Llamada e historia de Bookings

- Estado: diferida; UI/evidencia adicional. Fuente: CIERRE S4/S5.
- Resultado futuro: navegar Booking/cambio/escalación → Llamada o acción humana;
  historia de Bookings y Eventos anterior/nuevo, no cadena de Compromisos.
  Booking referencia source_call y rango inclusivo real de segmentos de esa Llamada.
- Punto de entrada: `backend/src/tango/supabase/dashboard.ts`,
  `frontend/src/features/operation/operation-trace.tsx` y
  `frontend/src/app/dashboard/operations/[reference]/page.tsx`.
  `commitment-evidence.tsx` fue eliminado; no restaurarlo ni asignarlo como existente.
- Dependencia: DB-100, contrato de procedencia, DIF-05/06/11; DIF-03 solo para las
  acciones humanas nuevas. Capturar/vincular rango antes de insertar Booking,
  sin UPDATE posterior para adjuntar evidencia ni copiar texto al registro.
- Aceptación futura: acceso autorizado a audio por referencia de Llamada, nunca
  publicar credenciales/URL permanente. Separar pending, disponible, sin captura
  y evidencia expirada; checkpoint solo si existe correspondencia temporal real.
  Sin audio no hay reproductor ficticio; evidencia humana no se presenta como voz.
- Exclusión: recrear Compromisos, rellenar rangos/checkpoints históricos inventados
  o bloquear la consulta de hechos estructurados cuando la evidencia haya expirado.

### DIF-08 · Semántica observable de sourcing y notificaciones

- Estado: diferida; mejora general del dossier. Fuente: CIERRE S3/S5.
- Resultado futuro: UI distingue cola, aceptación Twilio, atención, oferta,
  Cotización, Booking y email realmente entregado; explica selección determinista.
- Punto de entrada: `backend/src/tango/supabase/dashboard.ts`,
  `tango/services/email-gateway.ts`, UI de operación existente.
- Dependencia: DOC-501 y definir evidencia de entrega que soporte el servicio de email.
  Aceptación futura: no afirmar entrega por estar en outbox ni por aceptación de API;
  razones de selección tienen fuente de servidor y no exponen topes a Proveedores.
- Exclusión: panel de negociación nuevo o envío de notificaciones extra.

### DIF-09 · Aviso de conservación antes de contenido operativo

- Estado: pendiente de alcance de implementación; requisito vigente de CONTEXT.
- Dueño propuesto: coordinador de voz; no concurrente con INT-402.
- Punto de entrada: saludo y hooks de `backend/src/tango/realtime/agents-call-session.ts`,
  `backend/src/tango/realtime/realtime-session.ts` y wiring de `backend/src/server.ts`.
- Resultado: toda Llamada operativa inbound/outbound informa que se graba y
  transcribe antes de tratar datos o condiciones del viaje. No es consentimiento
  de Mandato ni nueva aprobación comercial.
- Dependencias: habilitar explícitamente este cambio de saludo; definir contrato
  compartido con DIF-06/10 para marcar progreso del aviso y comienzo de contenido
  operativo con señales reales, incluso si hay interrupción/corte.
- Aceptación futura: aviso emitido una vez por Llamada, reconnect no lo duplica;
  no asumir que crear una respuesta equivale a haber reproducido el aviso.
  No interpretar una interrupción ambigua como permiso para omitirlo.
- No tocar: VAD, runner nuevo, identidad, política de negociación ni llamadas de prueba.
- Handoff futuro: composición del aviso, marcadores persistidos y tratamiento de
  barge-in/corte definido por el coordinador, sin fingir señal de escucha inexistente.

### DIF-10 · Disposición de evidencia de intentos sin interacción

- Estado: pendiente de alcance de implementación; requisito vigente de CONTEXT.
- Dueño propuesto: coordinador de evidencia/SQL; archivos exactos se reservan al activar.
- Punto de entrada: captura de `call-transcript-repository.ts`, callbacks de
  Llamada/grabación en `backend/src/server.ts` y mecanismo durable de disposición.
- Resultado: llamada cortada durante aviso y sin contenido operativo conserva
  metadata de intento, pero no audio ni transcript. No basta que no haya Booking
  o tool para considerarla «sin interacción».
- Dependencias: contratos DIF-09 y DIF-06; autorización separada para eliminación
  real en DB/Twilio, sin efectuarla durante planificación o implementación local.
- Aceptación futura: clasificación por marcadores observados; caso ambiguo queda
  pendiente de resolución, no borrado indiscriminado. Disposición idempotente,
  auditable y resistente a callback de grabación tardío; no reaparece audio/texto
  descartado al reintentar ingestión. Conservar calls.id, status, ronda y contador.
- No alterar retry: si fue atendida y cortó, no rediscado; no reclasificar como
  no-answer para reutilizar presupuesto. Sin cambios de telefonía/HITL.
- Handoff futuro: criterio exacto, estados de disposición, trabajo durable y
  permisos; nunca ejecutar una purga sobre datos reales como prueba.

### DIF-11 · Retención de 90 días de audio y transcript

- Estado: pendiente de alcance de implementación; requisito vigente de CONTEXT.
- Dueño propuesto: coordinador de evidencia, con propiedad exclusiva de SQL/worker
  que se asigne; sin interferir con los carriles activos.
- Punto de entrada: metadata de Llamada/transcript, referencia Twilio de DIF-06,
  trabajo durable de disposición y read model de evidencia de DIF-07.
- Resultado: audio y texto operativo se conservan 90 días; después permanecen
  Bookings/Eventos/hechos estructurados, no evidencia conversacional recuperable.
- Dependencias: DIF-06/10 y alcance autorizado; congelar antes de implementar
  instante base del plazo, zona horaria, estados y permisos de borrado externo.
  El plazo ya está decidido; no inventar su anclaje técnico desde el glosario.
- Aceptación futura: vencimiento durable e idempotente, progreso por recurso y
  reintentos de disposición sin llamadas telefónicas; fallar en Twilio no produce
  falso «audio eliminado». URL/callback tardío no restaura evidencia expirada.
- Resolver retención con las FK de rangos y Bookings inmutables: conservar IDs/
  metadata mínima de segmentos sin texto cuando haga falta, o mecanismo compatible
  publicado antes de purgar; nunca modificar Bookings ni borrar por cascade hechos
  estructurados. Incluir extractos/copias persistidas si conservan evidencia textual.
- No tocar: plazo por conveniencia del agente, borrar datos reales sin autorización
  ni afirmar cumplimiento de conservación antes de entregar este alcance.
- Handoff futuro: contrato de expiración, resolución de referencias, runbook de
  disposición y estado visible «Evidence expired» para DIF-07.

## 13. Gates externos: no son tareas de implementación autorizadas

### ACT-01 · Activar migraciones y backend compatible

- Estado: requiere autorización explícita; no ejecutar desde un ticket Luna.
- Fuente: PLAN §15; parte operativa de CIERRE G0. Dependencia: DOC-501.
- Dueño: coordinador con acceso autorizado y responsable del entorno.
- Runbook: pausar dispatch, drenar llamadas antiguas, aplicar M0→MB→M1→M2→M3 por mecanismo
  versionado, desplegar backend compatible, retirar worker anterior y reanudar.
  Confirmar mecanismo real de cada plataforma; no SQL Editor ni supuesta atomicidad.
- Prerrequisito: establecer estado real de la migración recibida 200000 y resolver
  cualquier bloqueo de aplicación sin editarla silenciosamente ni perder historia.
  No activar el puente con writers viejos como si ya garantizara inmutabilidad.
- Observación técnica pendiente: en una instalación fresca, la migración original
  `20260830200000_bookings_replace_commitments.sql` contiene un `UPDATE ... FROM
  LATERAL` cuyo subquery referencia el alias objetivo `o`; confirmar con el dueño
  de SQL la resolución autorizada antes de aplicar migraciones. No se ejecutó ni se
  editó la migración original como parte de este backlog.
- Resolver el alcance de DIF-06/07/09/10/11 antes de activar llamadas operativas:
  incluir su entrega o explicitar con el usuario qué activación limitada se autoriza.
  No asumir que esos requisitos están cumplidos por aparecer en CONTEXT.
- Aceptación operativa futura: registrar versiones y resultados reales de aplicación/
  deploy, sin llamadas/emails de validación. La reanudación puede contactar trabajos
  reales pendientes: debe quedar incluida en la autorización, no ser una sorpresa.
- Fallo: detener dispatch nuevo, conservar calls/Bookings/recibos/Outbox y corregir
  hacia adelante; no rollback SQL destructivo ni worker viejo incompatible.
- No incluye G6 ni permiso de producir llamadas de prueba.

### ACT-02 · Validación de release y trial by fire

- Estado: deshabilitada por restricción vigente; requiere cambiar explícitamente
  la política «sin pruebas/QA/llamadas» y autorizar entorno/destinos/costos.
- Fuente: CIERRE G0/G6. Dependencia: ACT-01 y alcance de release acordado.
- Alcance futuro, no ejecutar ahora: checks RPC/migraciones/configuración,
  harnesses relevantes, dos salientes, booking/emails, inbound por demora,
  reemplazo, handoff vivo y consulta de evidencia.
- Matriz futura: no-answer, barge-in, ambigüedad, fuera de Mandato, REFER fallido,
  reinicio worker, callback duplicado/desordenado y migración ausente; recovery
  documentado y trial improvisado por una persona.
- Aceptación futura: resultados y evidencia por escena, fallos explícitos y ninguna
  afirmación de éxito apoyada solo en aceptación API. Ruido/idioma mixto/barge-in
  generan trabajo adicional solo si bloquean y se autoriza corregirlo.

### Mapeo del backlog histórico sin duplicar issues

No se consultó GitHub; los números son los referenciados por CIERRE, no estados
actuales verificados. Cuando se autorice convertir tickets en issues, enlazar
historia y conservar IDs de este documento; no cerrar issues por inferencia.

| Issues históricas según CIERRE | Destino en super backlog |
| --- | --- |
| #8, #14, #15, #16, #18 | SV-3/4/5/6, DIF-08. |
| #11, #13, #17 | SV-1, DIF-01, ACT-01. |
| #12, #20 | SV-2, DIF-02/03/05/06/07. |
| #19 | SV-2/4/6, DIF-04/07. |
| #3, #21 | ACT-02, hoy deshabilitada. |

## 14. Plantillas listas para asignar

El modelo de los futuros implementadores es Luna por pedido del usuario. Este
documento no crea tareas ni agentes. Elegir ticket listo y copiar el bloque con
su ficha completa; nunca entregar solo un título o todos los diferidos.

### Prompt para Luna

```text
Implementá únicamente <ID y título> de docs/super-backlog.md.
Tu carril es <P1/P2/P3>; tus archivos autorizados son <rutas exactas de la ficha>.
Las dependencias entregadas son <IDs y resumen/imports/contratos producidos>.

Leé AGENTS.md, docs/provider-call-flow-implementation-plan.md, los acuerdos de
docs/provider-call-flow-design.md y las secciones 1–4 y la ficha de tu ticket en
docs/super-backlog.md. Leé también CONTEXT.md y
docs/adr/0003-bookings-inmutables-sin-compromisos.md. El ADR/contexto y las correcciones
de la revisión 2 del super backlog prevalecen sobre los pasajes viejos del PLAN;
para el resto el PLAN prevalece sobre backlog-completion.
Aplicá los contratos BL-001/BL-002 ya publicados y los criterios de la ficha.

No redefinas producto, nombres de tools/RPCs, límites, permisos o política comercial.
No cambies reglas de Cliente, SDK, modelo, voz, VAD, SIP, HITL, Directory ni grabaciones.
DB-100 permite solo la adaptación técnica de writers/readers/triggers existentes
al Booking inmutable, sin acciones nuevas. No recrees Compromisos ni copies los
timestamps viejos del PLAN. DIF-09/10/11 no pertenecen a esta tanda activa.
No escribas ni ejecutes pruebas, harnesses, mocks, fixtures, QA, scripts de
validación ni llamadas de validación. No ejecutes despliegues/migraciones ni
dispares emails/llamadas. No toques secretos, producción, main o CI.

Trabajá solo en los archivos asignados y preservá cambios preexistentes. Un archivo
de otro dueño se pide al coordinador con el cambio exacto; no lo edites ni crees
un contrato paralelo. No delegues esta tarea en otros agentes.
Implementá código real, sin TODO esencial, datos simulados ni as any para ocultar
incompatibilidades. No agregues dependencias ni compatibilidad permisiva.

Entregá: archivos/símbolos modificados, criterios cubiertos por código, contratos
consumidos/producidos, migración si aplica, wiring requerido y limitaciones reales.
No afirmes que se probó o desplegó: esta entrega excluye ejecución de validaciones.
Si hay bloqueo, reportá el contrato/archivo exacto, su dueño y la mínima decisión
necesaria; seguí solo con lo independiente dentro del alcance.
```

### Handoff por ticket

```text
Ticket:
Estado: entregada al coordinador | bloqueada
Archivos y símbolos:
Contratos consumidos / producidos:
Criterios de aceptación → archivo/símbolo que los implementa:
Migración y dependencias de orden:
Wiring o cambio solicitado al coordinador:
Limitaciones / bloqueos concretos:
Pruebas y despliegue: no ejecutados, según alcance.
```

### Instrucción al coordinador para una tanda futura

```text
Ejecutá los tickets activos de docs/super-backlog.md usando implementadores Luna.
Primero cerrá BL-001/002 y publicá contratos. Después mantené hasta tres carriles
simultáneos (SQL, Voz, Telefonía), con un solo ticket en curso por carril y un
dueño por archivo. Los diferidos y ACT-01/02 no están autorizados.
Usá la revisión 2 alineada con ADR 0003: SQL empieza en DB-100; cinco migraciones
nuevas posteriores a 200000, Bookings inmutables y readers por current_booking_id.
No delegues server.ts, routing, contratos compartidos ni runner: integrá P4 como
coordinador después de las tres entregas. Respetá la exclusión de pruebas/QA y
efectos externos. Cerrá DOC-501 con implementación integrada y limitaciones honestas.
```
