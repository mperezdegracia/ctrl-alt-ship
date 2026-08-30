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

## Tercer tramo: confirmar mandato

Implementado localmente, bajo la misma bandera. Se extendió la migración **todavía
no aplicada** `20260830010000_client_operation_tools.sql`:

- `ConfirmMandateTool` aparece únicamente en `client_confirm`, junto a editar.
  El cliente completa precio máximo, moneda, ventanas con zona horaria y plazo
  mínimo desde fecha de factura; el prompt pide resumir todos los términos y
  esperar aprobación explícita en el turno siguiente. No se agregan mandate drafts.
- El servicio valida importes compatibles con `numeric(14,2)`, días enteros y
  ventanas ordenadas con fechas válidas; PostgreSQL vuelve a validar la entrada.
- La revisión `updated_at` observada por el servidor acompaña la ejecución fuera
  de los argumentos de la tool. Bajo lock, una revisión diferente devuelve
  `stale_operation`: resumir el estado actualizado y obtener otro consentimiento.
- Se insertan el mandato inmutable con snapshot de la fila bloqueada, versión y
  `supersedes_mandate_id`, eventos `mandate.confirmed`/`sourcing.started` y recibo
  idempotente en una sola transacción. Se actualiza el mandato vigente, se limpia
  `mandate_confirmation_required` y la operación pasa a `sourcing`.
- `calls.client_tools_completed_at` hace terminal el flujo de esa llamada sin
  fingir que la llamada telefónica terminó. El guard SQL impide nuevas mutaciones;
  un reintento del comando original sigue devolviendo el resultado persistido.
- `ConfirmationEvidenceTracker` captura eventos del SDK por llamada. Correlaciona
  el resumen de audio, respuesta finalizada y reproducción SIP terminada con el
  siguiente turno de usuario y con el `response_id` que solicita la tool.
  Interrupciones, audio truncado, transcripción ausente/fallida, otra intervención
  o una edición invalidan la evidencia. No usa un "yes" viejo ni texto del modelo
  como transcripción del usuario. Si la transcripción llega tarde se exige volver
  a resumir/confirmar; no se espera indefinidamente ni se inventa evidencia.
- La evidencia mínima se guarda en `mandates.confirmation_evidence`, nunca en
  eventos, resultados públicos o prompts: IDs de items/respuesta/evento, resumen,
  intervención del usuario y `input_audio_end_ms`. `confirmed_at` lo genera SQL.
  Los mandatos históricos pueden tener evidencia nula; la nueva tool la exige.
- `input_audio_end_ms` es un offset del audio de Realtime, **no** un checkpoint de
  la grabación Twilio. No se rellena `events.recording_checkpoint` con ese valor.
  La correlación con una grabación externa sigue pendiente.
- La aprobación inequívoca y la fidelidad semántica del resumen siguen siendo
  responsabilidad del agente conversacional. La captura verifica procedencia,
  orden y disponibilidad, **no clasifica** automáticamente el significado del sí/no.
- `sourcing.started` registra entrada/reentrada al estado, con `provider_count: 0`.
  Este tramo no selecciona/contacta transportistas, no manda emails ni modifica
  bookings históricos. Esos handlers deberán exigir el mandato vigente y una
  nueva aceptación; un booking bajo el mandato anterior no autoriza nuevos términos.

Pruebas: `harness:tools:client` añade contrato de confirmación, argumentos inválidos,
contexto confiable, perfil terminal, replay sin evidencia local y errores seguros.
`harness:tools:evidence` cubre reproducción, interrupciones, correlación de turnos,
ASR fuera de orden y aislamiento. Ambas son simuladas, sin PostgreSQL/OpenAI real;
no demuestran atomicidad ni semántica del consentimiento en una llamada real.

La captura sigue los eventos y limitaciones de
[transcripción Realtime](https://developers.openai.com/api/docs/guides/realtime-transcription)
y [reproducción/interrupciones SIP](https://developers.openai.com/api/docs/guides/realtime-conversations).

La configuración dinámica sigue el mecanismo documentado de
[sesiones Realtime](https://developers.openai.com/api/docs/guides/realtime-conversations).

## Transporte OpenAI SDK

- `OpenAIRealtimeGateway` centraliza `client.realtime.calls.accept/reject` y
  `OpenAIRealtimeWS({ callID }, client)` usando el mismo cliente oficial del webhook.
- El SDK configura autenticación y URLs, parsea eventos entrantes y serializa los
  eventos salientes. El servidor recibe eventos tipados y envía objetos tipados;
  solo los argumentos/resultados de las tools siguen siendo cadenas JSON del protocolo.
- Se conserva `ws` porque es el peer dependency del transporte Realtime del SDK;
  el servidor ya no construye un WebSocket manualmente.
- Aceptación/rechazo tienen timeout de 10 segundos y `maxRetries: 0` para no
  repetir implícitamente decisiones sobre llamadas. Los errores de aceptación
  siguen devolviendo HTTP 502 al webhook; el rechazo conserva SIP 603.
- El ACK del webhook ya no incluye la API key en un header de respuesta.
- `npm --prefix backend run harness:realtime:sdk` prueba el SDK real con HTTP y
  socket simulados: aceptación/rechazo, URL de sideband, correlación de tool calls,
  cambios de sesión, errores de API/transporte y frames inválidos. Sin red real.

Referencia: [OpenAI Realtime: controles del servidor](https://developers.openai.com/api/docs/guides/realtime-server-controls).

## Lo que todavía falta del #13

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
