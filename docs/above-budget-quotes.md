# Aceptación de precio después del bargain

Tango intenta mejorar el precio antes de finalizar, sin insistir cuando el
Proveedor se muestra harto o pide dejar de negociar. La primera
contraoferta cuenta como el primer intento; si el precio sigue sobre el tope,
puede hacer hasta dos intentos en total. Si el proveedor acepta una rebaja o
ofrece un precio dentro del tope antes, puede pasar a la confirmación final.
Un rechazo explícito del trabajo o un pedido de hablar con una persona se respeta.

Después de cada respuesta real que mantiene el precio fuera del tope, se registra
la cotización y quedan 1 o 0 intentos con el límite predeterminado. Mantener el
mismo importe después de rechazar una nueva rebaja también cuenta. El agente no
debe inventar importes ni ejecutar herramientas repetidamente para consumir
intentos sin conversación. La base conserva las versiones y no cuenta replays.

Al agotarse los intentos, o antes si el Proveedor muestra fastidio o se niega
a seguir regateando, Tango pide una única confirmación explícita para
avanzar al importe final si el proveedor resulta seleccionado. La herramienta
`create_quote` acepta `accept_above_budget: true` y guarda una nueva versión
inmutable con `accepted_above_budget: true`. Para el cierre anticipado se registra también
`negotiation_stopped_by_provider: true`. El fastidio no es consentimiento: siempre
se requiere aprobación final del importe. Sin ese motivo, el backend rechaza una aceptación
sobre el tope prematura con `negotiation_required` y no permite una tercera
contraoferta fuera del tope. Un importe que mejore voluntariamente hasta entrar
en el tope sigue siendo admisible tras el segundo intento.

La aceptación no cambia el Mandato ni fabrica una aprobación del Cliente o del
Supervisor: aplica la excepción de precio solicitada para Tango. La cotización
sigue clasificada `fuera`, con una marca explícita de aceptación. Esa versión
puede ser seleccionada para un Booking; una propuesta fuera del tope sin esa
marca no puede. No se saltan la moneda, las ventanas, los términos fijos, la
pertenencia al proveedor, la versión del mandato ni la vigencia de la ronda.
Las reglas de reprogramación de un Booking existente no cambian.

El dashboard muestra **Accepted above budget** y los eventos de cotización,
selección y booking conservan la marca. No se le revela al Proveedor el tope
privado ni la comparación. Aceptar la cotización no garantiza ganar ni acorta
la ventana de comparación de cinco minutos.

Aplicar las migraciones pendientes en orden, incluida
`20260830232500_preserve_quote_immutability.sql` y
`20260830233000_accept_above_budget_quotes.sql`, antes del backend y
frontend correspondientes. Las cotizaciones históricas conservan aceptación
falsa; no se seleccionan retroactivamente por estar fuera del tope. Los intentos
ya registrados cuentan al retomar una negociación.

Verificación desde `backend`:

- `npm run harness:quotes:above-budget`: validación de argumentos, scope, SDK,
  resultado aceptado y cierre de herramientas sin forzar otra negociación.
- `npm run harness:quotes:above-budget:sql`: PostgreSQL 16 desechable sin red;
  dos intentos, precio mantenido, aceptación explícita, idempotencia, booking
  por encima del tope, Mandato intacto, evidencia del transcript por versión
  y rechazos de scope/contexto inválidos.
- `npm run harness:quotes:legacy-evidence:sql`: reproduce `quotes is append-only`
  con la migración de evidencia original y comprueba la reparación forward.

La confirmación verbal la interpreta el agente, igual que en los demás comandos
de voz; el backend valida estado y datos, no demuestra el contenido del audio.
