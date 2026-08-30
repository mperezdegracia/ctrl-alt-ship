# Decisiones de implementación

## Escalación humana

- El destinatario humano de una escalación se resuelve desde la tabla
  `handoff_recipients`; no hardcodear un número en `backend/src/server.ts`.
- Theo (`+5491132555829`) se carga como destinatario inicial del demo en una migración,
  pero debe poder editarse, desactivarse o reemplazarse desde la UI de Directory.
- No agregar una variable de entorno (`SUPERVISOR_PHONE` o equivalente) ni un feature
  flag para el destino. Las credenciales de servicios sí deben seguir en variables de entorno.
- El número de transferencia es un destino outbound con el `9` móvil argentino.
  No cambiar el caller ID inbound guardado en la base por este motivo: se compara
  exactamente con el número recibido de Twilio y puede venir sin ese `9`.
