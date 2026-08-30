# Loop de llamadas salientes

El backend inicia `OutboundSourcingLoop` al abrir el servidor HTTP. Es un loop
async en TypeScript dentro del mismo proceso: no requiere cron, otro servicio,
un comando adicional ni nuevas variables de entorno. Arranca con `npm start`
desde `backend`, como el servidor habitual.

Cada iteración toma como máximo un contacto de la cola persistida, solicita la
llamada a Twilio y guarda el resultado. También revisa la selección de propuestas.
Cuando hay un candidato listo, pasa por el [juez acotado](bidding-minimal.md)
antes de adjudicar, sin repetir revisiones ya guardadas para ese contexto.
Después espera cinco segundos antes de repetir; la primera iteración es inmediata.
Las iteraciones no se superponen y los errores registrados no detienen el loop.

Cada vuelta registra `sourcing.worker_poll` en nivel `info`, incluso con la cola
vacía, con número de iteración, tabla `public.outbox`, tipo `contact_provider` e
intervalo de 5000 ms. El intervalo es la espera entre vueltas: si el trabajo tarda,
los logs estarán separados por ese tiempo adicional. El log indica que se consulta
la cola, no que se haya iniciado o atendido una llamada.

No espera a que termine la conversación para despachar otro contacto. Las llamadas
mantienen su propio contexto de operación/proveedor en el backend. El cliente
puede cortar después de confirmar el mandato: el loop no depende de esa sesión.

El servidor debe permanecer encendido: si el hosting suspende o reinicia el proceso,
el loop se detiene y vuelve a arrancar con el backend. Este cambio no agrega
recuperación de trabajos que ya quedaron en `processing`, ni garantiza que una
llamada aceptada por Twilio haya sido atendida. Los trabajos pendientes siguen en
la base de datos. No se modifica el worker de emails.

Verificación: revisión estática solamente; sin ejecutar tests ni llamadas reales.
