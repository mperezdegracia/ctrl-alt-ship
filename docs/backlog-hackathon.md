# Backlog ejecutable — flete conversacional

## Meta demostrable

Con datos de prueba, Carlos llama, describe un traslado Puerto → González
Catán, recibe un `operation_id`, el sistema contacta al menos dos proveedores
en paralelo, recibe y compara dos cotizaciones, confirma una reserva bajo una
regla explícita y genera dos emails de confirmación. El dashboard permite ver
la trazabilidad completa.

## Orden crítico

```text
vertical slice de telefonía
        └─> herramientas + operación durable
               └─> worker y proveedor simulado
                      └─> selección / booking / emails
                             └─> dashboard y ensayo E2E
```

> **Nota (29-08):** el backlog vive ahora en GitHub Issues
> (labels `kind:` / `area:` / `state:`, parents #4–#7). Forma de trabajo
> acordada: **trunk-based** — cada slice es un PR a `main` que deja el deploy
> de Render funcionando (auto-deploy desde la hora 1, issue #9); nada de
> ramas por persona. Sin test suites formales: cada slice se verifica con su
> **harness** ejecutable (curl / conversación de texto / seed) y cada sección
> importante se grilla en equipo antes de generarla con IA. Las áreas son
> etiquetas, no dueños: cualquiera agarra la próxima issue `state:ready`.
> La sección de abajo queda como referencia del razonamiento original.

## Reparto en 4 frentes independientes (24 hs, una PC por frente)

**Hora 0 (todos juntos, ~1 h): congelar los contratos.** Es lo único que
bloquea a los demás; después cada frente trabaja y prueba solo, mockeando al
resto. Se commitea antes de separarse:

1. Migración SQL completa (operaciones, proveedores, pedidos de cotización,
   cotizaciones, bookings, compromisos, llamadas, eventos, outbox).
2. JSON Schemas de las tools (`create_operation`, `update_operation`,
   `create_quote` con veredicto de mandato, `confirm_booking`, `escalate`).
3. Nombres y payloads de eventos + checkpoints temporales.
4. Nombres de variables de entorno y un `.env.example`.

| Frente | Alcance (tareas) | Cómo prueba SOLO, sin los demás |
| --- | --- | --- |
| **A · Telefonía** | Spike Twilio↔Realtime (P0-04), túnel/webhooks (P0-05), ruteo inbound (P0-16), conference de escalación (P0-15). | Llamadas reales con un agente "eco" tonto, sin dominio. Criterio: audio bidireccional + escalación a un celular del equipo. |
| **B · Dominio** | Migraciones (P0-03), tools con veredicto (P0-06), outbox/worker (P0-08), selección/booking (P0-10), emails (P0-11). | Todo por HTTP/curl y tests contra Supabase; el "agente" es un script que pega a las tools. |
| **C · Agentes y guion** | Prompts cliente/proveedor (P0-07, P0-09), negociación de una vuelta, tope oculto, triggers de escalación, guion + fixtures (P0-01). | Harness en modo texto contra un mock de tools; recién integra voz cuando A libera el spike. |
| **D · Evidencia y deploy** | Dashboard con timeline de compromisos y replay (P0-12), Render + E2E (P0-02, P0-13), grabación Twilio. | Dashboard contra datos seed del esquema congelado; deploy con el agente eco de A. |

**Puntos de integración (los únicos dos momentos de dependencia):**

- **~Hora 12:** A+B+C ensamblan una llamada real que crea una operación
  (smoke test del camino feliz).
- **~Hora 20:** E2E completo deployado + ensayo del trial by fire con uno del
  equipo haciendo de juez hostil (regatea, interrumpe, pide fuera de mandato,
  exige el tope). Lo que no entró hasta acá, se corta.

## Tareas

| ID | Prioridad | Trabajo | Entregable y criterio de aceptación | Depende de |
| --- | --- | --- | --- | --- |
| P0-01 | P0 | Acordar el guion de demo, tres proveedores ficticios y la regla de selección. Incluye el seed del **ERP del cliente (mock)**: empresa, contactos autorizados (Carlos) y proveedores habituales con teléfonos/emails. | Un fixture reproducible con Carlos, dos cotizaciones válidas, una inválida/sin respuesta, números/emails de prueba y criterio de cierre. Tango puede consultar el ERP (`SELECT` proveedores, validar contactos). **Incluye cargar el número del juez como proveedor antes del trial by fire** (los desconocidos se rechazan). | — |
| P0-02 | P0 | Crear el proyecto TypeScript, variables de entorno y validación de configuración. | `README` permite arrancar el API y el worker sin secretos en el repositorio. | — |
| P0-03 | P0 | Modelar y migrar Postgres: operaciones, proveedores, requests, cotizaciones, bookings, llamadas, eventos y outbox. | Crear una operación y releer su timeline por `operation_id`. | P0-02 |
| P0-04 | P0 | **Spike de telefonía:** configurar un número Twilio y probar inbound + outbound con Realtime/SIP; si falla, Media Streams como alternativa. | Dos llamadas de prueba con audio bidireccional y correlación por IDs. Documentar la ruta elegida y errores conocidos. | P0-02 |
| P0-05 | P0 | Exponer el runtime por Cloudflare Tunnel y configurar/verificar los webhooks de Twilio y OpenAI. | Se verifican firmas y un webhook público responde correctamente desde una llamada real. | P0-04 |
| P0-06 | P0 | Implementar herramientas validadas de operaciones. | El agente puede crear y actualizar una operación; los esquemas rechazan datos incompletos y las mutaciones son idempotentes. | P0-03 |
| P0-07 | P0 | Escribir y probar el agente de cliente. | Completa los campos críticos, confirma el resumen y llama únicamente a las herramientas permitidas. Guarda transcript/resumen. | P0-04, P0-06 |
| P0-08 | P0 | Implementar outbox/worker, límite de concurrencia y solicitud a N proveedores. | Una operación inicia N trabajos; reintentar un job no duplica llamada/cotización. | P0-03, P0-06 |
| P0-09 | P0 | Escribir y probar el agente de proveedor, con negociación de una vuelta. | Devuelve una cotización JSON válida o un no-disponible, enlazado a la operación/proveedor correctos. Si la oferta excede el mandato, `create_quote` devuelve el veredicto (`dentro`/`fuera`/`contraofertá`) y el agente contraoferta **una** vez sin revelar jamás el tope. | P0-04, P0-06 |
| P0-10 | P0 | Implementar comparación, selección y confirmación. | La regla queda visible, una cotización no válida no puede ganar y no se confirma sin la transición correcta. | P0-08, P0-09 |
| P0-11 | P0 | Integrar email con plantilla para cliente y proveedor. | Tras `booking_confirmed` se crean exactamente dos envíos idempotentes; en dev se pueden inspeccionar sin enviar a personas reales. | P0-10 |
| P0-12 | P1 | Dashboard mínimo de operación. | Muestra estado, cotizaciones, llamada/eventos, elección y enlaces a evidencia. | P0-03, P0-10 |
| P0-15 | P0 | Escalación mid-call: mover la llamada a una conference de Twilio, marcar al supervisor y pasarle contexto. | El supervisor entra a la llamada viva sin que se corte; recibe (SMS/link al dashboard) compromisos, mandato y motivo. El agente anuncia el pase y se retira. | P0-04, P0-07, P0-12 |
| P0-16 | P0 | Ruteo inbound por caller ID: número conocido → persona (cliente/proveedor) con operación activa precargada; desconocido → rechazo. | El despachante de un booking vigente que llama es atendido por el agente proveedor sabiendo qué operación es; un número no registrado no llega a un agente. | P0-03, P0-04 |
| P0-17 | P0 | Cambios post-booking y renegociación: el proveedor pide mover el retiro; dentro de la ventana de acción la IA reprograma sola, fuera escala. Escena inversa: la situación cambia y el agente llama al proveedor para mover lo acordado. | El booking reprogramado queda como compromiso nuevo con rastro del anterior; el caso fuera de ventana dispara P0-15. | P0-10, P0-15, P0-16 |
| P0-13 | P0 | Desplegar runtime y DB de demo; hacer ensayo E2E. | URL pública estable, secretos configurados, prueba completa grabada/screenshot y guion de recuperación. | P0-05 a P0-11 |
| P1-14 | P1 | Observabilidad y guardrails. | `operation_id` está en logs/trazas; hay timeouts, límites de llamadas y un botón/manual path para cancelar. | P0-13 |

## Corte de alcance recomendado

**Para que el demo llegue:** una sola clase de carga, 3 proveedores de prueba,
2 cotizaciones, regla de menor precio válido, confirmación simulada, dos emails
y un dashboard de una vista.

**No construir antes de que el flujo funcione:** marketplace real, precios
dinámicos, pagos, optimización multi-variable, cuentas de usuario, RAG,
regateo iterativo con ancla/precio objetivo (follow-up declarado; por ahora
una sola contraoferta), identificación conversacional de números desconocidos
(por ahora se rechazan) o un framework de multi-agentes adicional. La narrativa gana más con fiabilidad,
trazabilidad y buena voz que con complejidad invisible.

## Riesgos a cerrar en la próxima conversación

1. ~~¿El agente puede elegir automáticamente o Carlos debe aprobar?~~
   **Resuelto:** Carlos define un mandato por voz en la llamada inicial y el
   agente cierra solo dentro de él. El email final es confirmación, no
   aprobación.
2. ~~¿Qué define la carga de la demo?~~ **Resuelto:** ver "Fixture del demo"
   en `docs/glosario-del-dominio.md` (Textiles del Plata, 40' dry, PBA →
   González Catán, ARS, devolución del vacío como dato fijo).
3. ¿Qué harán cuando un proveedor no responde: timeout y eligen entre los
   demás, o se llaman de vuelta a Carlos?
4. ~~¿Tienen un número Twilio con capacidad SIP?~~ **Resuelto:** verificado,
   la cuenta lo soporta.
