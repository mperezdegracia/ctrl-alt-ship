# Backlog de cierre — Tango

**Estado:** borrador vivo, 2026-08-30.
**Objetivo:** terminar un sistema de coordinación de fletes por voz que sea
demostrable en el challenge sin inventar identidad, operación, autorización ni
compromisos. Cuando este documento quede acordado, cada slice se convierte en
una issue de GitHub; no sustituye la trazabilidad de las issues.

## Definiciones ya acordadas

- La pantalla, estados, acciones y ayudas operativas están en **inglés**. La
  conversación y los extractos literales conservan el idioma real del
  interlocutor.
- El caller ID autentica el ámbito de datos de la llamada. No determina la
  intención, la operación concreta, ni la solución.
- Toda llamada entrante empieza con `intent = unknown` y
  `operation = unresolved`. Tango pregunta sólo la información necesaria para
  elegir un camino. Ninguna mutación usa una operación inferida.
- Las tools, permisos, ventanas de acción y transiciones son del servidor. El
  modelo sólo conversa, busca/aclára información disponible y solicita una
  transición permitida.
- Una persona puede pedir un humano sin conocer una operación. Ese handoff se
  permite y se registra como una escalación de llamada con operación no
  resuelta; una mutación de dominio sí exige una operación exacta.
- El supervisor ve tres fuentes distintas: **Caller said** (evidencia
  literal), **Verified system context** (estado de servidor) y **Operator
  decision needed** (trigger/acción estructurados). Una síntesis del modelo no
  se presenta como un hecho verificado.
- Para este demo, cualquier usuario autenticado del dashboard puede ejecutar
  acciones humanas. Cada una conserva `actor_user_id`, motivo, antes/después,
  timestamp y control de concurrencia.
- Operaciones, mandatos, quotes, compromisos, evidencias y acciones humanas
  son append-only. Un booking representa el estado actual; sus cambios crean
  un cambio/decisión/compromiso nuevo que referencia la historia previa.
- Un `operator override` puede cambiar el estado de la operación en el demo
  inmediatamente. Se muestra como decisión humana, **no** como aceptación de
  un carrier si esa aceptación no ocurrió.
- Una nota de operador sólo documenta. Nunca dispara llamadas, sourcing ni
  cambios de estado. Cualquier automatización parte de un comando estructurado.

## Forma de trabajo

La unidad de entrega es un **slice vertical**: una conducta visible de punta a
punta, con migración, backend, prompt/capacidades, UI, auditoría y prueba. Así
no terminamos con pantallas que prometen acciones que el servidor no puede
hacer, ni tools que nadie puede revisar.

Sólo hay dos gates horizontales deliberados:

1. **G0 · Baseline integrado:** todas las migraciones y configuración que los
   slices necesitan están desplegadas y verificables contra Supabase/Render.
2. **G6 · Validación de release:** prueba real de llamadas, grabaciones,
   recuperación y trial by fire después de integrar los slices.

Cada issue debe incluir: alcance, fuera de alcance, contrato/estados tocados,
criterios de aceptación, prueba automática o harness, y prueba real si toca
voz/servicios externos. No se cierra por tener TypeScript compilando.

## Dependencias

```text
G0 ─┬─> S1 Deterministic inbound context ─> S2 Honest handoff + human decisions
    ├─> S3 Outbound sourcing to booking ──> S4 Disruption and recovery
    └─> S5 Evidence and operator console ─┘

S1 + S2 + S3 + S4 + S5 ─> G6 Release validation
```

## Gates y slices de cierre

### G0 · Baseline integrado y contrato ejecutable

**Resultado:** no hay código que dependa de una RPC/migración/configuración
que sólo exista localmente o de forma simulada.

- Auditar el orden completo de migraciones forward-only, incluyendo las de
  tools de cliente, cotización, booking, sourcing, dashboard y handoffs.
- Aplicarlas mediante el flujo versionado del proyecto; no mediante SQL Editor.
- Configurar y verificar el runtime: Supabase, Render, webhooks de OpenAI y
  Twilio, worker de sourcing, grabaciones y email en el modo elegido.
- Convertir los checks importantes de RPC en pruebas contra la base compartida
  de demo, sin secretos en el repositorio.
- Inventariar cada tool anunciada y eliminar instrucciones contradictorias o
  históricas. Ejemplo conocido: cancelación de booking con/sin email.

**Aceptación:** `db:check`, typecheck y harnesses existentes pasan; las RPCs
requeridas responden en el entorno; cada tool habilitada tiene handler y
transición compatibles; ningún prompt promete una capacidad ausente.

### S1 · Llamada entrante determinista: identidad no es intención

**Resultado:** una persona registrada puede llamar sin que Tango le adjudique
un trabajo, una operación o una petición que no expresó.

- Separar en el estado de sesión identidad autenticada, intención conversada y
  operación seleccionada.
- Para un provider con varias operaciones candidatas, presentar sólo el mínimo
  contexto necesario y pedir desambiguación antes de cualquier tool mutante.
- Para una sola candidata, se puede proponerla; no queda seleccionada sin una
  confirmación inequívoca del interlocutor.
- Mantener el rechazo de números no registrados. No se implementa todavía
  verificación de identidad por voz.
- Alinear saludos, perfiles dinámicos y prompts para que el primer turno sea
  una pregunta de intención cuando la llamada es inbound.

**Aceptación:** fixtures de client/provider con cero, una y varias operaciones;
peticiones ambiguas y contradictorias; ninguna ruta permite mutar una operación
no elegida explícitamente; la UI y los logs distinguen `unresolved` de una OP.

### S2 · Escalación honesta y decisiones humanas

**Resultado:** una persona puede pasar a un humano sin inventar una operación,
y el dashboard permite que cualquier usuario autenticado decida de forma
auditable.

- Extender el modelo de escalación para soportar `operation unresolved`, ligado
  a la llamada y a su evidencia. Mantener operación obligatoria en cambios de
  booking, quotes y mandatos.
- Reemplazar los campos libres del modelo como fuente principal de la UI por
  `Caller said`, `Verified system context` y `Operator decision needed`.
- Mostrar con precisión `transfer requested`, `transfer failed` y, sólo si se
  puede demostrar, `human connected`. No tratar un SIP REFER aceptado como
  respuesta humana.
- Incorporar comandos de operador, todos con actor/motivo/evento:
  - `Add operator note`;
  - `Approve/reject requested change`;
  - `Cancel booking`;
  - `Approve exception`;
  - `Request replacement sourcing` (instrucción durable; el dispatch
    automático queda para S4 o follow-up).
- Un override actualiza el estado de demo mediante un comando transaccional y
  deja explícito su origen humano. No fabrica una confirmación del carrier.

**Aceptación:** escalación por petición humana sin OP; escalación fuera de
mandato con OP; dashboard totalmente en inglés y sin hechos inferidos;
before/after y autor consultables; reintentos idempotentes y conflictos de
revisión seguros.

### S3 · Sourcing saliente hasta booking confirmado

**Resultado:** un mandato confirmado produce el ciclo entero de búsqueda y
adjudicación, no sólo una cola o una cotización aislada.

- Mandato → hasta dos contactos elegibles → llamadas Twilio/SIP → quote o
  rechazo → hasta tres revisiones de precio → selección determinista de
  servidor → booking → outbox de emails.
- Respetar tope, moneda, equipo, ventana y demás condiciones sin exponer el
  límite privado al provider ni comparar quotes ajenos en el modelo.
- Recuperar reinicios, reintentos técnicos, no-answer y timeout de comparación
  sin duplicar llamadas, quotes, bookings ni notificaciones.
- Definir y reflejar en UI qué significa cada estado: llamada aceptada por
  Twilio, atendida, quote recibida, booking confirmado y email entregado.

**Aceptación:** dos proveedores de prueba reciben conversaciones reales o
simuladas de extremo a extremo según el entorno; una oferta inválida no gana;
exactamente un booking y dos notificaciones idempotentes al caso feliz; el
dashboard explica la regla que eligió.

### S4 · Incidente post-booking y recuperación

**Resultado:** un carrier puede informar demora/cancelación y el sistema
resuelve sólo lo autorizado, deriva lo demás y conserva la historia.

- Reprogramar una ventana dentro de mandato con confirmación explícita,
  `change_request`, compromiso sucesor y booking actual coherente.
- Ante cambio fuera de mandato, crear una solicitud de revisión sin alterar el
  booking y abrir S2.
- Cancelar un booking de provider sin cancelar la operación del cliente; dejar
  la operación disponible para recuperación.
- Permitir al operador aprobar/rechazar el change request existente, cancelar
  o emitir la instrucción durable de reemplazo.
- Implementar la renegociación/sourcing de reemplazo iniciada por comando
  explícito. No debe arrancar por una nota ni por una inferencia textual.

**Aceptación:** se pueden reproducir demora dentro/fuera de ventana,
cancelación, rechazo humano y reemplazo; los compromisos anteriores siguen
consultables y no hay mutaciones cruzadas entre providers.

### S5 · Evidencia que se puede defender

**Resultado:** cada estado relevante muestra de dónde salió y el dashboard no
finge reproducibilidad que no tiene.

- Persistir segmentos de transcripción de caller y Tango, correlacionados con
  llamada/Realtime y manejando reintentos.
- Persistir callbacks de grabación de Twilio y su relación con la llamada.
- Para cada commitment o cambio relevante, guardar la fuente correcta:
  checkpoint/extracto de llamada o acción humana. Un override humano no se
  etiqueta como evidencia conversacional.
- Permitir replay sólo cuando existe URL de grabación; mostrar "Recording
  pending" cuando no existe, no un reproductor ficticio.
- Añadir al dossier de operación la cadena de supersedes y la línea de tiempo
  de decisiones humanas, cambios y calls.

**Aceptación:** desde un booking, cambio y escalación se puede navegar a la
llamada/acción que los produjo; los extractos son literales y tienen fuente;
la ausencia de audio está señalizada con honestidad.

### G6 · Release validation y trial by fire

**Resultado:** cada requisito del challenge tiene una prueba repetible en el
entorno desplegado, no una combinación de harnesses locales.

- Checklist de configuración y smoke de Supabase, Render, Twilio, OpenAI,
  worker, grabación y email.
- Ensayo de dos llamadas salientes, booking, email, llamada inbound por demora,
  renegociación/reemplazo, handoff en vivo y consulta de evidencia.
- Matriz de fallos: carrier no responde, interrupción/barge-in, dato ambiguo,
  petición fuera de mandato, SIP REFER fallido, worker reiniciado y migración
  ausente.
- Guion de recovery y una persona que improvise el trial. La conversación es
  real aunque los números y carriers sean de prueba.

**Aceptación:** evidencia guardada de cada escena, resultados y fallos
documentados, y ningún claim de éxito que sólo sea una aceptación de API.

## Fuera de este cierre

- Roles y permisos finos dentro del dashboard.
- Verificación conversacional para números desconocidos o detección de otro
  agente.
- Dispatch automático a replacement sourcing directamente desde una nota.
- Marketplace, pagos, optimización de múltiples variables, RAG y negociación
  fuera del precio definido.
- Barge-in, ruido y español/inglés mixto como mejoras de robustez; se ensayan
  en G6 y se convierten en trabajo adicional sólo si bloquean la demo.

## Mapeo del backlog histórico

Las issues existentes describen hitos iniciales y no reflejan totalmente el
estado del código. Al pasar este documento a GitHub, se conservan como
historia y se enlazan así:

| Backlog histórico | Slice de cierre |
| --- | --- |
| #8, #14, #15, #16, #18 | S3 |
| #11, #13, #17 | G0 y S1 |
| #12, #20 | S2 y S5 |
| #19 | S4 |
| #3, #21 | G6 |
