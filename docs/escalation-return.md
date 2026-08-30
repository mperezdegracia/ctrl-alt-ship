# Volver desde la escalación humana

`escalate` abre la revisión durable y conserva el contexto, pero ya no dispara
la despedida automáticamente. Tango pregunta si la persona quiere transferir
ahora o volver a continuar el flujo. En ese paso solo están disponibles
`confirm_escalation` y `cancel_escalation`.

Ante «volver atrás», «seguir con vos» o un pedido equivalente, Tango cancela
el pase y recarga el estado autorizado. La cancelación resuelve esa revisión
con `resolution: cancelled`, conserva su historial y no modifica la operación,
el mandato, el booking ni la negociación. La operación seleccionada y la
intención de la llamada permanecen vinculadas: volver no permite cambiar de
operación ni autoriza una solicitud fuera del mandato.

La transferencia requiere una confirmación explícita posterior. Antes de esa
confirmación se puede volver al flujo; después, Tango da una despedida breve
protegida y el coordinador solicita SIP REFER cuando termina su reproducción.
La voz, el ruido o un «dale» durante la despedida no desarman el pase ni requieren
otra confirmación. Se desactivan las respuestas automáticas y las interrupciones
de VAD (`create_response: false`, `interrupt_response: false`), y se bloquea además
la interrupción local del SDK. Se retiran las herramientas conversacionales al
confirmar, por lo que Tango no sigue ofreciendo volver atrás durante el pase.
Confirmado no significa que una persona haya contestado. REFER se envía una sola
vez, incluso con eventos de audio duplicados o resultado de red incierto.
Configuración contrastada con la [documentación oficial de VAD](https://developers.openai.com/api/docs/guides/realtime-vad).

Sin destinatario configurado se puede cancelar igual. Si falla la persistencia
de la cancelación, el pase queda desarmado pero la revisión sigue abierta; Tango
no debe afirmar que volvió al flujo. Si falla la recarga del estado, se retiran
las herramientas por seguridad.

Aplicar `20260830232600_cancel_pending_escalation.sql` antes de desplegar el
backend. No hay cambios de configuración, caller ID ni destinatario: este sigue
resolviéndose desde `handoff_recipients`.

Verificación local desde `backend`:

- `npm run harness:realtime:agents`: confirmación separada, regreso, estado
  conservado, herramientas bloqueadas durante revisión y replay del SDK.
- `npm run harness:escalation`: voz durante despedida protegida, cancelación, error de persistencia
  y exclusión mutua con la transferencia.
- `npm run harness:escalation:cancel:sql`: migraciones y RPC en PostgreSQL 16
  desechable sin red; autorización, idempotencia, datos preservados y límite de
  transferencia. No usa credenciales de la base real.

## Reprogramación dentro de ventana

`reschedule_booking` recibe `proposed_pickup_local_window` con horas locales sin
offset. SQL agrega el offset explícito común de las ventanas del mandato vigente;
el modelo no infiere horario de verano ni convierte a UTC. El contexto incluye
`pickup_utc_offset` y `pickup_local_window` ya convertida para leer correctamente la reserva almacenada. Si las ventanas
tienen offsets distintos, se rechaza la conversión local ambigua sin modificar
la reserva. El formato anterior con instantes zonificados sigue siendo compatible
con invocaciones y replays existentes, pero no se anuncia al modelo.

«A cualquier hora de ese día» conserva el día completo, de 00:00:00 a 23:59:59.
Si está contenido en una ventana autorizada y siguen vigentes los demás términos,
se aplica directamente con una confirmación verbal, sin escalación humana.
Fuera de ventana se conserva la reserva anterior y primero se ofrecen los
horarios permitidos que devuelve el servidor. Tango pregunta: «Mirá, los horarios
posibles son [fechas y horarios]. ¿Podés en alguno de estos?» y espera la respuesta.
Si el transportista elige uno, confirma el cambio y lo aplica en la misma llamada.
Si no puede en ninguno, `decline_reschedule_alternatives` registra el rechazo y
recién entonces se habilita `escalate`. Silencio, preguntas o querer conservar la
reserva original no cuentan como rechazo. No se abren revisiones humanas mientras
se están ofreciendo alternativas; solo se comparten horarios, no límites de precio
ni otros términos privados. Si ya no quedan horarios futuros utilizables, el
servidor permite pasar a revisión directamente.

En OP-000015 el mandato autorizaba los días 3 y 4 completos con UTC−06:00. La
solicitud original usó UTC−05:00 y comenzó una hora antes de la segunda ventana.
La regresión reproduce esa clasificación fuera de ventana y verifica que las
mismas horas locales, convertidas por SQL con UTC−06:00, sí se aplican conservando
el día completo.

Aplicar `20260830234000_local_booking_reschedule_windows.sql` antes de reiniciar
el backend actualizado. No modifica mandatos, reservas existentes, caller IDs ni
destinatarios. Verificación: `npm run harness:bookings:windows:sql`, con PostgreSQL
16 desechable y todas las migraciones, sin tocar Supabase real.

Aplicar también `20260830235000_offer_booking_windows_before_escalation.sql`
antes de activar el nuevo paso de alternativas. La prueba SQL cubre elección
de un horario en la misma llamada, rechazo de todos, replay y bloqueo de una
escalación directa que intente saltear este paso.
