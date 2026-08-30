# Implementación de tools — issue #13

## Primer tramo: consultas reales

- `list_open_operations` consulta las operaciones abiertas del contacto autenticado.
- `list_provider_operations` consulta las operaciones del proveedor y distingue
  pedido de cotización, booking pendiente y booking confirmado. Un booking activo
  sigue visible aunque su pedido de cotización original haya vencido; un pedido
  vencido sin booking activo no se lista.
- Ambas tools rechazan argumentos: llamada e identidad se inyectan desde el servidor.
- Cada llamada tiene su propio registry. El cliente no recibe tools del proveedor
  ni viceversa; los handlers también verifican la persona y la autorización.
- En cada ejecución se consulta que la llamada persistida coincida con su ID de
  Realtime, persona y contraparte, y que siga marcada activa. Se revalida actividad
  de la contraparte y autorización del cliente.
- Las respuestas usan listas explícitas de campos públicos del contrato. No incluyen
  UUIDs, teléfonos, emails, topes ni cotizaciones de otros proveedores.
- Se retiró el `get_operation_status` simulado y sus datos inventados. Se usan los
  nombres de consulta definidos en `contracts/tools.schema.json`.
- Los argumentos JSON inválidos reciben un resultado de error por sideband en vez
  de dejar al modelo esperando. Los errores de base no se envían al modelo.
- Este tramo no requiere migraciones ni modifica datos de Supabase.

Responsabilidades OOP: `CallToolFactory` crea el registry por llamada;
`OperationReadService` aplica la autorización; `SupabaseOperationReadRepository`
consulta la base; las clases de tools validan argumentos y exponen el contrato.

## Verificación

- `npm --prefix backend run typecheck`
- `npm --prefix backend run harness:tools:read`: sin PostgreSQL ni red; ejecuta
  los filtros y proyecciones reales del repositorio sobre un transporte en memoria.
  Cubre contratos, aislamiento, permisos revocados, llamadas terminadas, argumentos
  con IDs inyectados, relaciones de proveedor, datos incompletos y errores seguros.
- Harness inbound de cliente, proveedor y desconocido.
- Se ejecutaron ambas tools en modo solo lectura contra Supabase usando llamadas
  existentes: devolvieron `OP-900001` en el contexto correspondiente.
- Pendiente probar este tramo en una llamada real después de desplegarlo.

## Segundo tramo: crear/editar y perfiles dinámicos

Implementado en código, pendiente de aplicar la migración y activar en el entorno:

- `create_operation` y `update_operation`, con validación estricta en TypeScript
  y nuevamente dentro de la función transaccional de PostgreSQL.
- IDs y referencias generados por los defaults existentes de PostgreSQL; no se
  acepta `id`, `reference`, IDs de contraparte ni términos de mandato en argumentos.
- Los borradores quedan en `collecting_details`; faltantes permanecen nulos.
- Peso positivo compatible con `numeric(12,3)`, sin redondear silenciosamente.
- La primera creación/edición vincula la operación y fija la intención en `calls`.
- La transacción bloquea la fila de llamada y, al editar, la de operación. Guarda
  la mutación, los eventos y el resultado idempotente en la misma transacción.
- `tool_command_receipts` usa `(call_id, tool_call_id)` como clave: un reintento
  con el mismo comando devuelve su resultado original; reutilizar la clave con
  argumentos diferentes falla. No hay estado idempotente exclusivamente en memoria.
- La actividad/autorización se valida incluso antes de devolver un resultado repetido.
- La edición compara contra la fila actual: no reescribe campos omitidos y no emite
  otro `operation.updated` cuando no hay cambios. Un cambio de términos de una operación
  con mandato activa el trigger existente de `mandate_confirmation_required`.
- `CallToolSession` refresca el estado persistido; `session.update` reemplaza tools
  e instrucciones antes de continuar con la respuesta del modelo. Una lectura de
  estado fallida retira las tools; no convierte una mutación ya confirmada en un fallo.
- Entrada: listar/crear/editar. Después de elegir: únicamente editar la operación
  seleccionada. Datos completos: perfil `client_confirm` con editar/confirmar mandato.
  Cancelación todavía no está habilitada.
- Al actualizar el prompt se retiran los flujos incompatibles y el contexto de otras
  operaciones. El idioma sigue siendo el del usuario.

### Activación

1. Incorporar `supabase/migrations/20260830010000_client_operation_tools.sql` mediante
   el flujo de migraciones del proyecto. No se aplicó manualmente a la base compartida.
2. Verificar que las funciones nuevas y la tabla de resultados estén disponibles.
3. Configurar `CLIENT_OPERATION_TOOLS_ENABLED=true` en el backend y reiniciarlo.
   Por defecto es `false`; con la bandera apagada siguen disponibles solo las consultas.
4. Validar en el entorno de destino crear, completar, editar y confirmar mandato,
   incluidos reintentos y cambios concurrentes. El #13 todavía no está terminado.

`npm --prefix backend run harness:tools` ejecuta las pruebas de consultas y el nuevo
harness de cliente. Este último usa respuestas RPC simuladas para verificar argumentos,
contexto, claves de idempotencia, errores públicos y cambios de tools/prompts. **No
ejecuta PostgreSQL ni prueba la atomicidad o concurrencia de la migración SQL.**
No se hicieron pruebas mutantes contra Supabase ni se activó la bandera en Render.

## Estado vigente: mandato conversacional y Agents SDK (2026-08-30)

Los tramos anteriores describen su implementación original. Esta actualización
reemplaza el gate de evidencia de audio y el loop manual de tools.

- Después de crear o seleccionar una operación aparecen update_operation y
  confirm_mandate, incluso cuando faltan campos. SQL no confirma pedidos incompletos.
- El agente resume operación y condiciones y espera el sí explícito. Sin
  ConfirmationEvidenceTracker ni needsApproval; interpretar ese sí depende del modelo.
- Se conservan autorización, revisión de operación, snapshots/versiones inmutables,
  eventos, estado terminal e idempotencia en la misma transacción.
- Migración nueva: 20260830020000_conversational_mandate_confirmation.sql.
  No altera el archivo de migración ya aplicado ni borra evidencias históricas.
- RealtimeAgent/RealtimeSession/OpenAIRealtimeSIP controlan tools e historial.
  OpenAIRealtimeGateway conserva REST accept/reject y no usa OpenAIRealtimeWS.
- Saludo inicial en inglés para cliente y proveedor; luego idioma del usuario.
- Se conserva el escalamiento Twilio. No se implementaron nuevas tools de proveedor
  ni cancelación ni despacho real de sourcing en esta actualización.

Detalle de decisiones, limitaciones, compatibilidad SDK y orden de despliegue:
[realtime-confirmation-review.md](realtime-confirmation-review.md).

Pruebas: harness:tools, harness:realtime:sdk, harness:realtime:agents y
harness:realtime:diagnostics. Son simuladas, sin PostgreSQL ni llamadas reales.

## Lo que todavía falta del #13

El diagnóstico de tools enviadas/observadas y la revisión de SDK/HITL están en
[realtime-confirmation-review.md](realtime-confirmation-review.md). Los nuevos
logs permiten inspeccionar el flujo, pero no prueban consentimiento humano.

- Aplicar/validar los tramos de escritura y mandato; implementar cancelar operaciones.
- Extender las transacciones e idempotencia al resto de mutaciones.
- Perfiles y bloqueo de intención de los flujos de proveedor.
- Registrar quotes y calcular el veredicto y la ronda de negociación en el servidor.
- Confirmar/rechazar bookings, reprogramar/cancelar, negativas y escalación.
- Capturar evidencia desde la llamada para compromisos, sin argumentos controlados
  por el modelo; preservar la cadena `supersedes`.
- Integrar las notificaciones y el handoff con sus respectivos componentes.
- Harness completo de mutaciones y validación contra Render.

No se anuncian tools de mutación hasta implementar sus handlers y verificaciones,
y activar el tramo correspondiente.
El prompt explica que una acción sin tool disponible no puede ejecutarse en esa llamada.
Estos tramos no completan los criterios de aceptación del #13.
