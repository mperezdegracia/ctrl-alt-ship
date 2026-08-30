# Coordinación de fletes por voz

Agentes de voz que corren la pata terrestre de un envío por teléfono: toman el
pedido del cliente, cotizan con proveedores en paralelo, cierran bajo mandato y
dejan un rastro auditable de reservas y eventos.

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
fuera del mandato también se guardan; las que superan únicamente el tope de precio
pueden seleccionarse si tienen una **Aceptación sobre el tope** explícita.
Una Cotización completa confirmada por el Proveedor durante la Llamada autoriza
su selección, pero no crea un Booking por sí sola.
_Avoid_: quote, confundir con una mera Propuesta de precio

**Aceptación sobre el tope**:
Confirmación explícita de avanzar con el importe final de una Cotización aunque
supere el precio del Mandato, después de intentar mejorarlo hasta dos veces o dejar de negociar antes por
fastidio o negativa del Proveedor a seguir regateando.
Es una excepción para esa Cotización, sin modificar
el Mandato ni autorizar otros cambios de condiciones.

**Propuesta de precio**:
Importe o rango que el Proveedor ofrece para una Operación, incluida su primera
oferta y cada contraoferta. Se conserva como hecho histórico aunque exceda lo
autorizado; registrarla no implica aprobación ni Booking.

**Booking**:
Reserva inmutable creada por el servidor sobre la Cotización seleccionada. Una Operación referencia explícitamente su Booking vigente; al reemplazarlo se crea otro Booking, sin modificar el anterior.
_Avoid_: compromiso, reserva mutable, cierre

**Solicitud de cambio**:
Pedido explícito de un cliente o proveedor sobre un booking vigente. En el MVP
es una reprogramación con una única ventana propuesta o una cancelación. El
servidor la evalúa contra el mandato y la aplica o escala.
_Avoid_: editar el booking sin registrar el pedido

**Renegociación**:
Proceso de volver a solicitar cotizaciones cuando el Mandato vigente es incompatible con el Booking vigente. Llama en paralelo a los Proveedores elegibles, selecciona la mejor Cotización válida y crea un Booking nuevo que reemplaza al vigente sin borrar el rastro.
_Avoid_: recotización

**Escalación**:
Pase de una llamada viva al supervisor sin cortar, entregando Booking vigente, mandato y motivo — nunca el transcript crudo.
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
Persona de conversación de cara a proveedores: presenta el pedido, negocia y registra Cotizaciones, incluida una Aceptación sobre el tope cuando se confirma
explícitamente el importe final; las demás condiciones del Mandato siguen vigentes.

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

**Transcript**:
Registro textual completo, ordenado e inmutable de los turnos de una Llamada; es evidencia de la conversación y pertenece a la Llamada, incluso cuando no produce un Booking.
_Avoid_: reserva, resumen de la llamada

**Rango de evidencia**:
Intervalo inclusivo de segmentos de Transcript de una misma Llamada que fundamenta un Booking, desde el turno inicial que aporta contexto hasta el turno final de confirmación. El Booking referencia el rango, pero no duplica su contenido.
_Avoid_: transcript copiado, extracto de transcript

**Grabación**:
Audio de una Llamada, alojado en Twilio durante el MVP y localizado por una referencia de grabación de Twilio y su estado. No es una URL pública ni pertenece al Booking.
_Avoid_: archivo de un Booking, URL pública de audio

**Aviso de conservación**:
Anuncio inicial de Tango de que la Llamada se graba y transcribe para fines operativos. Se realiza en toda Llamada operativa antes de tratar datos o condiciones de negocio.
_Avoid_: consentimiento de Mandato, aviso implícito

**Intento sin interacción**:
Llamada que termina durante el Aviso de conservación y no contiene contenido operativo. Conserva los metadatos de intento, pero no el audio ni el Transcript.
_Avoid_: Llamada operativa, llamada fallida con evidencia

**Retención de evidencia**:
Plazo de 90 días durante el MVP para conservar el audio y el Transcript de una Llamada operativa. Al vencer, se preservan los hechos estructurados pero no su evidencia conversacional.
_Avoid_: archivo permanente de llamadas

**Dirección de la llamada**:
Indica quién inició la comunicación telefónica desde la perspectiva de Tango. Permanece igual aunque cambie el tema de la conversación.
_Avoid_: deducir la dirección por quién habla primero o por la intención del Proveedor

**Llamada entrante**:
Llamada iniciada por un Cliente o Proveedor hacia Tango.

**Llamada saliente**:
Llamada iniciada por Tango hacia una contraparte autorizada.

**Propósito de la llamada**:
Motivo de negocio que enmarca la conversación, como gestionar un Booking o solicitar una Cotización. Es distinto de quién inició la llamada.

**Intención en la llamada**:
Acción concreta que se busca realizar dentro del propósito de la llamada, como reprogramar o cancelar un Booking. Puede estar sin decidir al comenzar la conversación.

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
- Sólo una **Cotización** aceptada dentro del mandato, o con **Aceptación sobre el tope** y las demás condiciones vigentes, puede ser seleccionada para un **Booking**
- El **Booking** es inmutable; la Operación conserva la referencia al Booking vigente y los Bookings anteriores forman su historia
- Una **Renegociación** crea un Booking nuevo y reemplaza la referencia de Booking vigente sin borrar el anterior
- Durante una **Renegociación**, el **Booking** anterior sigue vigente y queda pendiente de reemplazo hasta que se confirme otro; si no hay Cotización válida, se conserva y se produce una **Escalación**
- Una cancelación deja la Operación sin Booking vigente; el Booking anterior no se borra y el motivo queda en un **Evento**
- Una **Escalación** entrega una **Llamada** viva al **Supervisor**, con el **Booking** vigente y el **Mandato** como contexto
- Toda **Llamada** operativa conserva su **Transcript**; un **Booking** sólo referencia la Llamada que lo evidencia
- Todo cambio dentro de la **Ventana de acción** lo resuelve el agente solo; fuera de ella, **Escalación**

## Example dialogue

> **Dev:** "El proveedor dijo que sí por teléfono, ¿ya tenemos el **Booking**?"
> **Domain expert:** "No — lo que tenés es una **Cotización**. El **Booking** existe recién cuando el servidor validó la cotización contra el **Mandato** y el proveedor confirmó explícitamente la reserva. El Booking referencia la Llamada y su Rango de evidencia."
> **Dev:** "¿Y si el despachante llama mañana y pide pasar el retiro al viernes?"
> **Domain expert:** "Si el viernes entra en la **Ventana de acción**, el agente reprograma solo y crea un Booking nuevo. Si no entra, no negocia: **Escalación** al **Supervisor** con la llamada viva."

## Flagged ambiguities

- "ventana de retiro" vs "ventana de acción" — resuelto: **Ventana de acción** es el término; cubre fijar *y* mover el retiro.
- "reserva" y "booking" se usaban indistinto — resuelto: **Booking**.
- El Transcript es evidencia de una Llamada; el Booking es la reserva estructurada que puede quedar vigente.
- Nombre del producto y del agente: resuelto como **Tango**.
- "Nuestros proveedores" — resuelto: los proveedores pertenecen al **ERP del cliente**; Tango llama a los fleteros habituales de la empresa de Carlos, no a un marketplace de Tango.
- "Preferencias" vs. **Mandato** — resuelto: no son capas distintas; todas las
  reglas expresadas por el cliente viven en una versión del mandato.
- Una cotización cara que luego mejora no se sobrescribe: se conservan ambas
  versiones. Sólo la versión aceptada puede producir un Booking.
