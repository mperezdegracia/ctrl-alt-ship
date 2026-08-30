# Decisiones de implementación

## Escalación humana

- El destino de escalación humana del demo es Theo: `+5491132555829`.
- Mantener el destino explícito en `backend/src/server.ts`; no agregar una variable
  de entorno (`SUPERVISOR_PHONE` o equivalente) ni un feature flag para configurarlo
  sin una nueva solicitud explícita del usuario.
- No volver a proponer convertir ese número en una variable de entorno como tarea
  pendiente. Las credenciales de servicios sí deben seguir en variables de entorno.
- El número de transferencia es un destino outbound con el `9` móvil argentino.
  No cambiar el caller ID inbound guardado en la base por este motivo: se compara
  exactamente con el número recibido de Twilio y puede venir sin ese `9`.
