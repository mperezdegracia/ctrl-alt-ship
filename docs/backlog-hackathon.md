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

## Tareas

| ID | Prioridad | Trabajo | Entregable y criterio de aceptación | Depende de |
| --- | --- | --- | --- | --- |
| P0-01 | P0 | Acordar el guion de demo, tres proveedores ficticios y la regla de selección. | Un fixture reproducible con Carlos, dos cotizaciones válidas, una inválida/sin respuesta, números/emails de prueba y criterio de cierre. | — |
| P0-02 | P0 | Crear el proyecto TypeScript, variables de entorno y validación de configuración. | `README` permite arrancar el API y el worker sin secretos en el repositorio. | — |
| P0-03 | P0 | Modelar y migrar Postgres: operaciones, proveedores, requests, cotizaciones, bookings, llamadas, eventos y outbox. | Crear una operación y releer su timeline por `operation_id`. | P0-02 |
| P0-04 | P0 | **Spike de telefonía:** configurar un número Twilio y probar inbound + outbound con Realtime/SIP; si falla, Media Streams como alternativa. | Dos llamadas de prueba con audio bidireccional y correlación por IDs. Documentar la ruta elegida y errores conocidos. | P0-02 |
| P0-05 | P0 | Exponer el runtime por Cloudflare Tunnel y configurar/verificar los webhooks de Twilio y OpenAI. | Se verifican firmas y un webhook público responde correctamente desde una llamada real. | P0-04 |
| P0-06 | P0 | Implementar herramientas validadas de operaciones. | El agente puede crear y actualizar una operación; los esquemas rechazan datos incompletos y las mutaciones son idempotentes. | P0-03 |
| P0-07 | P0 | Escribir y probar el agente de cliente. | Completa los campos críticos, confirma el resumen y llama únicamente a las herramientas permitidas. Guarda transcript/resumen. | P0-04, P0-06 |
| P0-08 | P0 | Implementar outbox/worker, límite de concurrencia y solicitud a N proveedores. | Una operación inicia N trabajos; reintentar un job no duplica llamada/cotización. | P0-03, P0-06 |
| P0-09 | P0 | Escribir y probar el agente de proveedor. | Devuelve una cotización JSON válida o un no-disponible, enlazado a la operación/proveedor correctos. | P0-04, P0-06 |
| P0-10 | P0 | Implementar comparación, selección y confirmación. | La regla queda visible, una cotización no válida no puede ganar y no se confirma sin la transición correcta. | P0-08, P0-09 |
| P0-11 | P0 | Integrar email con plantilla para cliente y proveedor. | Tras `booking_confirmed` se crean exactamente dos envíos idempotentes; en dev se pueden inspeccionar sin enviar a personas reales. | P0-10 |
| P0-12 | P1 | Dashboard mínimo de operación. | Muestra estado, cotizaciones, llamada/eventos, elección y enlaces a evidencia. | P0-03, P0-10 |
| P0-13 | P0 | Desplegar runtime y DB de demo; hacer ensayo E2E. | URL pública estable, secretos configurados, prueba completa grabada/screenshot y guion de recuperación. | P0-05 a P0-11 |
| P1-14 | P1 | Observabilidad y guardrails. | `operation_id` está en logs/trazas; hay timeouts, límites de llamadas y un botón/manual path para cancelar. | P0-13 |

## Corte de alcance recomendado

**Para que el demo llegue:** una sola clase de carga, 3 proveedores de prueba,
2 cotizaciones, regla de menor precio válido, confirmación simulada, dos emails
y un dashboard de una vista.

**No construir antes de que el flujo funcione:** marketplace real, precios
dinámicos, pagos, optimización multi-variable, cuentas de usuario, RAG o un
framework de multi-agentes adicional. La narrativa gana más con fiabilidad,
trazabilidad y buena voz que con complejidad invisible.

## Riesgos a cerrar en la próxima conversación

1. ~~¿El agente puede elegir automáticamente o Carlos debe aprobar?~~
   **Resuelto:** Carlos define un mandato por voz en la llamada inicial y el
   agente cierra solo dentro de él. El email final es confirmación, no
   aprobación.
2. ¿Qué define la carga de la demo y qué datos exige un proveedor para cotizar?
   Sin esto el agente no sabe qué preguntar.
3. ¿Qué harán cuando un proveedor no responde: timeout y eligen entre los
   demás, o se llaman de vuelta a Carlos?
4. ¿Tienen un número Twilio con capacidad SIP y números de prueba autorizados?
   Si no, P0-04 debe arrancar con Media Streams.
