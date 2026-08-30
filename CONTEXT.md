# Coordinación de fletes por voz

Agentes de voz que corren la pata terrestre de un envío por teléfono: toman el
pedido del cliente, cotizan con proveedores en paralelo, cierran bajo mandato y
dejan un rastro auditable de compromisos.

## Language

**Operación**:
La solicitud de transporte end-to-end, identificada por `operation_id`; es el agregado y la fuente de verdad.
_Avoid_: pedido, envío, shipment

**Cliente**:
Quien llama para pedir el flete y otorga el mandato.
_Avoid_: usuario, cuenta

**Proveedor**:
Transportista que cotiza y puede aceptar una reserva.
_Avoid_: carrier, fletero, despachante (el despachante es la persona que atiende del lado del proveedor)

**Mandato**:
Conjunto versionado de reglas dado por voz por el cliente — tope de precio con
moneda, una o más ventanas de acción y plazo mínimo de pago contado desde la
factura — bajo el cual el agente negocia y cierra solo. No existe una capa
separada de "preferencias": todo lo que condiciona una cotización vive en el
mandato. El servidor valida contra la versión vigente; el modelo nunca es la
autoridad.
_Avoid_: presupuesto, límite, budget

**Ventana de acción**:
Rango de fechas/horas del mandato dentro del cual el agente puede fijar o mover el retiro sin consultar a nadie; fuera de ella, escala.
_Avoid_: ventana de retiro

**Pedido de cotización**:
Trabajo idempotente que solicita a un proveedor una oferta para una operación. Un conjunto de Pedidos de cotización se cierra cuando todos alcanzan resultado terminal o vence su plazo de recolección.
_Avoid_: solicitud, request

**Cotización**:
Oferta estructurada e inmutable de un proveedor (precio, moneda, ventana de
retiro, plazo de pago, vigencia y condiciones); nunca equivale a booking. Una
negociación conserva cada versión enlazada con la anterior. Las propuestas
fuera del mandato también se guardan, pero no generan un compromiso aceptado.
Una Cotización completa confirmada por el Proveedor durante la Llamada autoriza
su selección, pero no crea un Booking por sí sola.
_Avoid_: quote, oferta, propuesta

**Booking**:
Compromiso de reserva sobre la Cotización seleccionada, creado por el servidor al seleccionar la mejor Cotización válida; a lo sumo uno vigente por Operación.
_Avoid_: reserva, cierre

**Compromiso**:
Hecho verificable (cotización aceptada, Booking, reprogramación o cancelación)
anclado a una Llamada, un instante y una versión del Mandato. Es inmutable; un cambio crea otro compromiso que
reemplaza al anterior sin borrarlo.
_Avoid_: transcript, acuerdo, promesa

**Solicitud de cambio**:
Pedido explícito de un cliente o proveedor sobre un booking vigente. En el MVP
es una reprogramación con una única ventana propuesta o una cancelación. El
servidor la evalúa contra el mandato y la aplica o escala.
_Avoid_: editar el booking sin registrar el pedido

**Renegociación**:
Proceso de volver a solicitar cotizaciones cuando el Mandato vigente es incompatible con el Booking vigente. Llama en paralelo a los Proveedores elegibles, selecciona la mejor Cotización válida y crea un compromiso nuevo que reemplaza al anterior sin borrar el rastro.
_Avoid_: recotización

**Escalación**:
Pase de una llamada viva al supervisor sin cortar, entregando compromisos, mandato y motivo — nunca el transcript crudo.
_Avoid_: transferencia, derivación, HITL

**Supervisor**:
Humano del lado de Tango, que opera sobre el ERP del cliente y recibe las escalaciones; en el demo, uno del equipo.
_Avoid_: operador, admin, agente humano

**Tango**:
El agente de voz que opera en nombre del ERP del Cliente; un solo sistema con dos personas de conversación (agente de cliente y agente de proveedor). En llamadas salientes se identifica transparentemente como asistente de logística de la empresa del Cliente.
_Avoid_: Jarvis, el bot

**ERP del cliente**:
Sistema de la empresa importadora sobre el que opera Tango; ahí viven los contactos autorizados y los proveedores habituales, y contra él se valida quién llama. En el demo es un mock con datos seed.
_Avoid_: nuestra base de proveedores (los proveedores son de la empresa de Carlos, no de Tango)

**Agente de cliente**:
Persona de conversación que atiende al cliente: toma el pedido, completa faltantes y captura el mandato.

**Agente de proveedor**:
Persona de conversación de cara a proveedores: presenta el pedido, negocia y registra compromisos; nunca cierra fuera del mandato.

**Devolución del vacío**:
Tramo final del drayage: entregar el contenedor vacío en el depósito indicado por la naviera; afecta la cotización del fletero y en el demo es un dato fijo, no negociable.
_Avoid_: confundir con demurrage/detention (cargos de la naviera, no tramos)

**Demurrage**:
Cargo de la naviera por cada día que el contenedor permanece en la terminal pasados los días libres; en el demo es la razón narrativa del límite de la ventana de acción.
_Avoid_: demora (a secas), detention

**Detention**:
Cargo de la naviera por retener el contenedor fuera del puerto más allá de los días libres antes de devolver el vacío.
_Avoid_: demurrage

**Llamada**:
Interacción telefónica entrante o saliente, correlacionada con una Operación y una contraparte autorizada (Cliente o Proveedor). Las entrantes se rutean por caller ID y las salientes nunca se dirigen a un número arbitrario.

**Evento**:
Hecho inmutable de auditoría con timestamp; los relevantes marcan checkpoints temporales para reproducir esa porción de la grabación.

**Outbox**:
Registro transaccional de trabajo pendiente que sobrevive caídas del servidor.
En la primera versión, una cancelación deja contactos alternativos en estado
pendiente; ningún worker los consume todavía.

## Relationships

- Una **Operación** representa exactamente un contenedor, pertenece a un
  **Cliente**, conserva todas las versiones de **Mandato** y referencia una
  sola como vigente
- Una **Operación** genera N **Pedidos de cotización**, cada uno hacia un **Proveedor** distinto
- Un **Pedido de cotización** puede producir varias versiones inmutables de
  **Cotización** durante la negociación
- Un **Booking** selecciona exactamente una **Cotización**
- Sólo una **Cotización** aceptada dentro del mandato puede producir un
  **Compromiso** y ser seleccionada para un **Booking**
- El **Booking** guarda el estado vigente; sus **Compromisos** guardan la
  historia inmutable
- **Cotización** aceptada, **Booking**, **Renegociación** y cancelación producen
  **Compromisos**; cada **Compromiso** ancla a una **Llamada**, un instante y
  una versión del **Mandato**
- Una **Renegociación** reemplaza un **Compromiso** anterior sin borrarlo
- Durante una **Renegociación**, el **Booking** anterior sigue vigente y queda pendiente de reemplazo hasta que se confirme otro; si no hay Cotización válida, se conserva y se produce una **Escalación**
- Una cancelación del proveedor cancela el **Booking**, crea un compromiso de
  cancelación y deja nuevos contactos a proveedores en el **Outbox**
- Una **Escalación** entrega una **Llamada** viva al **Supervisor**, con los **Compromisos** y el **Mandato** como contexto
- Todo cambio dentro de la **Ventana de acción** lo resuelve el agente solo; fuera de ella, **Escalación**

## Example dialogue

> **Dev:** "El proveedor dijo que sí por teléfono, ¿ya tenemos el **Booking**?"
> **Domain expert:** "No — lo que tenés es una **Cotización**. El **Booking** existe recién cuando el servidor validó la cotización contra el **Mandato** y el proveedor confirmó explícitamente la reserva. Y ambas cosas quedan como **Compromisos** anclados al momento de la llamada."
> **Dev:** "¿Y si el despachante llama mañana y pide pasar el retiro al viernes?"
> **Domain expert:** "Si el viernes entra en la **Ventana de acción**, el agente reprograma solo y el compromiso viejo queda reemplazado. Si no entra, no negocia: **Escalación** al **Supervisor** con la llamada viva."

## Flagged ambiguities

- "ventana de retiro" vs "ventana de acción" — resuelto: **Ventana de acción** es el término; cubre fijar *y* mover el retiro.
- "reserva" y "booking" se usaban indistinto — resuelto: **Booking**.
- Compromiso ≠ transcript — el transcript es evidencia; el **Compromiso** es el hecho estructurado que se puede exigir.
- Nombre del producto y del agente: resuelto como **Tango**.
- "Nuestros proveedores" — resuelto: los proveedores pertenecen al **ERP del cliente**; Tango llama a los fleteros habituales de la empresa de Carlos, no a un marketplace de Tango.
- "Preferencias" vs. **Mandato** — resuelto: no son capas distintas; todas las
  reglas expresadas por el cliente viven en una versión del mandato.
- Una cotización cara que luego mejora no se sobrescribe: se conservan ambas
  versiones. Sólo la versión aceptada produce compromiso.
