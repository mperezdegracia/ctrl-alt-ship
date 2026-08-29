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
Autorización dada por voz por el cliente — tope de precio con moneda y ventana de acción — bajo la cual el agente negocia y cierra solo; el servidor valida todo contra él, el modelo nunca es la autoridad.
_Avoid_: presupuesto, límite, budget

**Ventana de acción**:
Rango de fechas/horas del mandato dentro del cual el agente puede fijar o mover el retiro sin consultar a nadie; fuera de ella, escala.
_Avoid_: ventana de retiro

**Pedido de cotización**:
Trabajo idempotente que solicita a un proveedor una oferta para una operación.
_Avoid_: solicitud, request

**Cotización**:
Oferta estructurada de un proveedor (precio, moneda, vigencia, condiciones); nunca equivale a reserva.
_Avoid_: quote, oferta, propuesta

**Booking**:
Compromiso de reserva sobre la cotización seleccionada, con confirmación explícita del proveedor; a lo sumo uno vigente por operación.
_Avoid_: reserva, cierre

**Compromiso**:
Hecho verificable acordado en una llamada (cotización, booking, reprogramación) anclado a la llamada, al instante y al mandato que lo produjeron.
_Avoid_: transcript, acuerdo, promesa

**Renegociación**:
Llamada saliente del agente para mover un compromiso existente, siempre dentro del mandato; produce un compromiso nuevo que reemplaza al anterior sin borrar el rastro.
_Avoid_: recotización

**Escalación**:
Pase de una llamada viva al supervisor sin cortar, entregando compromisos, mandato y motivo — nunca el transcript crudo.
_Avoid_: transferencia, derivación

**Supervisor**:
Humano del lado del agente (Nauta operando sobre el ERP del cliente) que recibe las escalaciones; en el demo, uno del equipo.
_Avoid_: operador, admin, agente humano

**Tango**:
El agente de voz; un solo sistema con dos personas de conversación (agente de cliente y agente de proveedor).
_Avoid_: Jarvis, Volta, el bot

**ERP del cliente**:
Sistema de la empresa importadora sobre el que Nauta opera Tango; ahí viven los contactos autorizados y los proveedores habituales, y contra él se valida quién llama. En el demo es un mock con datos seed.
_Avoid_: nuestra base de proveedores (los proveedores son de la empresa de Carlos, no de Nauta)

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
Interacción telefónica correlacionada con una operación y una contraparte; las entrantes se rutean por caller ID y un número desconocido se rechaza.

**Evento**:
Hecho inmutable de auditoría con timestamp; los relevantes marcan checkpoints temporales para reproducir esa porción de la grabación.

**Outbox**:
Registro transaccional de trabajo pendiente que sobrevive caídas del servidor.

## Relationships

- Una **Operación** pertenece a un **Cliente** y tiene exactamente un **Mandato** vigente
- Una **Operación** genera N **Pedidos de cotización**, cada uno hacia un **Proveedor** distinto
- Un **Pedido de cotización** produce a lo sumo una **Cotización**
- Un **Booking** selecciona exactamente una **Cotización**
- **Cotización**, **Booking** y **Renegociación** producen **Compromisos**; cada **Compromiso** ancla a una **Llamada** y un instante
- Una **Renegociación** reemplaza un **Compromiso** anterior sin borrarlo
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
- Nombre del agente: el pizarrón decía "Jarvis" y el challenge "Volta" — resuelto: **Tango**.
- "Nuestros proveedores" — resuelto: los proveedores pertenecen al **ERP del cliente**; Tango llama a los fleteros habituales de la empresa de Carlos, no a un marketplace de Nauta.
