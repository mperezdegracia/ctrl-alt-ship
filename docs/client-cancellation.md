# Cancelación de operaciones del cliente

Decisión vigente: 2026-08-30. Implementada en código, pendiente de despliegue y
validación en el entorno. **No enviar ni encolar emails todavía.**

## Flujo

1. El cliente lista sus operaciones y elige una referencia real `OP-…`.
2. El agente obtiene el motivo, resume la cancelación y sus consecuencias:
   se cierra en el sistema, sin notificar al transportista.
3. Espera un sí explícito en el siguiente turno. Una negativa, pregunta,
   interrupción o cambio de objetivo no autoriza ejecutar la tool.
4. Ejecuta `cancel_operation({ operation_reference, reason })`.
5. Solo si tiene éxito anuncia la cancelación; retira todas las tools.

No usa `update_operation` para seleccionar el pedido, no crea/reemplaza un mandato
y no solicita aprobación del transportista. Si la llamada ya eligió create/update,
cancelar no está disponible. La intención conversacional se fija en PostgreSQL
al ejecutar la mutación, igual que los otros caminos.

El prompt separa consultas de escrituras con confirmación, y define cuándo usar
y cuándo evitar cada tool, siguiendo [OpenAI Docs: Realtime prompting](https://developers.openai.com/api/docs/guides/realtime-models-prompting).
Esto guía al agente; no demuestra que un humano oyó o aprobó la acción.
Se mantiene la decisión de no usar `needsApproval` ni tracking de audio.

## Implementación

- `CancelOperationTool` delega a `ClientOperationService.cancel`.
- El repositorio llama `execute_client_cancellation_tool`. Es un RPC separado
  para no reescribir la transacción existente de creación/edición/mandato.
- Revalida llamada activa, persona, identidad, contacto activo/autorizado y
  propiedad del pedido. Rechaza IDs internos, referencias inválidas, motivo vacío
  y argumentos extra en TypeScript y SQL.
- Bloquea la llamada y operación. Comparte `tool_command_receipts` con las otras
  mutaciones: mismo `(call_id, tool_call_id)` y argumentos devuelve el resultado
  original; otros argumentos fallan. Revalida autorización incluso en replay.
- Todo ocurre en una transacción: vincular llamada, intención `cancel`, marcador
  terminal, operación `cancelled`, booking pending/confirmed `cancelled` con fecha,
  eventos y recibo. Un nuevo comando sobre cancelled/failed se rechaza.
- No borra filas ni altera mandatos, quotes o compromisos históricos. No crea
  un compromiso de proveedor ficticio. Mantiene el mandato previo como historia
  y desactiva `mandate_confirmation_required` en la operación cancelada.
- Cierra quote requests pending/queued/contacted; conserva respuestas históricas.
  Rechaza change requests pending/escalated con `resolved_at`.
- Retira trabajos `contact_provider` pendientes del outbox marcándolos processed
  con `skipped_reason: operation_cancelled`; processed no significa contacto enviado.
- No inserta jobs de email ni eventos `email.*`. Tanto el resultado como los
  eventos de cancelación devuelven el indicador de notificación en `false`.

## Límites

- La confirmación verbal se interpreta en el modelo. SQL comprueba permisos,
  camino y estado, no el consentimiento. No acepta un `confirmed: true` inventado.
- La cancelación opera sobre la fila actual bloqueada; no incorpora un control
  optimista de revisión entre la consulta inicial y el sí. No debe describirse
  como evidencia de aprobación de una versión específica de la operación.
- No cuelga otras llamadas ni revoca contactos externos ya ejecutados. Workers
  futuros deben revalidar estado inmediatamente antes de contactar/confirmar;
  no se puede retirar una acción externa en curso solo cambiando la base.
- El transportista no recibe aviso automático. La cancelación registrada en
  el sistema no implica que esté enterado o haya aceptado nada.
- No implementa `cancel_booking` del proveedor (otro flujo: vuelve a sourcing).

## Despliegue y pruebas

Aplicar `supabase/migrations/20260830040000_client_cancellation.sql` después de
las migraciones anteriores, luego desplegar backend con
`CLIENT_OPERATION_TOOLS_ENABLED=true`. No requiere nueva variable de entorno.

Pruebas locales: typecheck, `harness:tools:client`, `harness:realtime:agents`.
Cubren contrato, validación, RPC/contexto, errores públicos, replay, aislamiento,
prompt y retiro de tools. Las aserciones SQL son estáticas: **no se ejecutó
PostgreSQL ni se probó atomicidad/concurrencia**. No se cancelaron datos reales,
no se llamó a OpenAI/Twilio ni se enviaron correos durante estas pruebas.

Validación manual pendiente con Lucas: [client-tools-lucas-test.md](client-tools-lucas-test.md).
