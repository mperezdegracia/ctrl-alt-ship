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

La transferencia requiere una confirmación explícita posterior. Si la persona
habla durante la despedida, el coordinador desarma el pase inmediatamente y
Tango debe escuchar y volver a confirmar, o cancelar. Un evento tardío de audio
no reactiva el pase. Desde que se inicia el pedido SIP REFER ya no se permite
cancelar, incluso si su resultado de red es incierto.

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
- `npm run harness:escalation`: interrupción, cancelación, error de persistencia
  y exclusión mutua con la transferencia.
- `npm run harness:escalation:cancel:sql`: migraciones y RPC en PostgreSQL 16
  desechable sin red; autorización, idempotencia, datos preservados y límite de
  transferencia. No usa credenciales de la base real.
