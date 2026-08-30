# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

El **Supervisor** de Tango opera el dashboard interno durante las excepciones y el seguimiento de la coordinación de fletes. En el MVP es el único rol con acceso al producto web.

## Product Purpose

Tango es el agente de voz que coordina por teléfono la pata terrestre de un envío: toma el pedido del Cliente, solicita cotizaciones a Proveedores, negocia dentro del Mandato y deja un rastro auditable de los Compromisos.

El dashboard permite al Supervisor seguir las Operaciones y hacerse cargo de las Escalaciones sin perder el contexto verificado de cada llamada, Mandato y Compromiso.

## Positioning

Tango no es un marketplace de fletes ni un bot que decide sin límites: actúa sobre el ERP del Cliente y sólo puede cerrar dentro de un Mandato versionado y validado por el servidor.

## Operating Context

El Supervisor interviene mientras hay llamadas activas o luego de ellas, con la necesidad de revisar Operaciones, Cotizaciones, Bookings, Compromisos y Escalaciones. Los contactos autorizados y los Proveedores habituales viven en el ERP del Cliente; durante el demo este ERP es un mock con datos seed.

## Capabilities and Constraints

- Una Operación representa un contenedor y conserva un único Mandato vigente.
- Las Cotizaciones y los Compromisos son inmutables; los cambios crean nuevos Compromisos que reemplazan a los anteriores sin borrar la historia.
- El servidor, no el modelo, valida el Mandato vigente.
- El agente resuelve cambios dentro de la Ventana de acción y escala los demás al Supervisor.
- El dashboard se autentica con Supabase Auth mediante email y contraseña, con recuperación de contraseña.
- No existe registro público: Tango crea las cuentas de Supervisor directamente desde Supabase Dashboard.
- Tras autenticarse, el Supervisor siempre llega al dashboard general; las Escalaciones activas se presentan allí como prioridad, sin redirección automática a una Operación.
- Toda la interfaz del producto, incluidos estados, acciones y datos simulados, se presenta en inglés.
- Las credenciales públicas de Supabase se configuran localmente mediante variables de entorno y no se guardan en el repositorio.

## Brand Commitments

El producto y su agente de voz se llaman Tango. El lenguaje de producto debe usar los términos definidos en `CONTEXT.md`.

## Evidence on Hand

- Glosario y reglas de dominio: `CONTEXT.md`.
- Backend de demo y datos seed: `backend/`.
- No hay todavía activos visuales, testimonios ni una identidad visual implementada que deban preservarse.

## Product Principles

- El Supervisor siempre recibe contexto verificable, no una transcripción cruda como sustituto de hechos.
- Toda acción debe respetar el Mandato y preservar trazabilidad.
- La Operación es la fuente de verdad para la coordinación de cada contenedor.
- La interfaz usa el lenguaje del dominio de forma consistente.
