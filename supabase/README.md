# Migraciones

`migrations/` es la única fuente de despliegue. Supabase las aplica desde `main`
mediante la integración GitHub, en orden de versión. `contracts/schema.sql` es
una referencia de las tablas e invariantes resultantes, **no otro bootstrap**:
no incluye todos los RPCs, workers ni grants y no se ejecuta contra Supabase.

## Historial aplicado: no reorganizar archivos

El baseline `f32482f` completó el check de Supabase. Sus 17 migraciones, y cada
migración verificada posteriormente, quedan registradas en
`migrations.lock.json` con nombre y SHA-256. No renombrarlas, reordenarlas,
borrarlas, fusionarlas ni editar sus checksums para ocultar cambios. Una
corrección requiere una **nueva migración posterior a la última versión**. Una
consolidación real requiere un procedimiento coordinado para entornos nuevos y
existentes; no se hace como una limpieza de nombres.

| Tramo | Qué incorpora | Definición vigente cuando fue reemplazada |
| --- | --- | --- |
| `20260829210000`–`20260829230000` | Tablas base, permisos, OP, rangos, snapshots y eventos | Mantener como origen histórico |
| `20260830000000` | Eventos de llamadas inbound sin operación | Validación de contexto inbound |
| `20260830010000` | Tools de cliente y recibos idempotentes | Ejecución reemplazada por `30000` |
| `20260830020000` | Mandato conversacional, sin gate de audio | Extendida por `30000` |
| `20260830025000` | IDs externos nulos mientras se inicia outbound | Sigue vigente |
| `20260830030000` | Confirmación incremental de mandato | RPC actual del cliente |
| `20260830040000` | Cancelación de cliente sin email | RPC actual de cancelación |
| `20260830050000` | Primera implementación de sourcing | Funciones reemplazadas por `90000` |
| `20260830050001` | Outbox de emails de adjudicación | Repetible por el incidente de renumeración |
| `20260830060000` | Límite de dos proveedores | Incorporado en `90000` |
| `20260830070000` | Quotes, negativas, mandato del pedido y tres rondas | Tools de cotización actuales |
| `20260830080000` | Reprogramación/cancelación y `get_provider_tool_state` | Tools de reservas actuales |
| `20260830090000` | Comparación por cinco minutos, espera abierta y adjudicación | Sourcing actual; revoca RPC legado |
| `20260830100000` | Enum `sourcing.dispatch_queued` y recarga de caché | Corrección del fallo de mandato |
| `20260830110000` | Dos proveedores activos al azar, sin filtro por equipo al contactar | Reemplaza `enqueue_mandate_sourcing` de `90000`; no reencola mandatos existentes |
| `20260830120000` | Consola operativa del dashboard | Auditoría de acciones humanas y vistas guardadas |
| `20260830120001` | Alta mínima: ruta obligatoria, logística adicional opcional y pago mínimo omitible | Reemplaza validaciones de operación/snapshot, ejecución cliente y selección; conserva filtros comerciales y equipo cuando fue especificado |
| `20260830130000` | Revisión LLM persistida antes de adjudicar | SQL conserva elegibilidad, reloj y selección; revisiones obsoletas o ambiguas no confirman |
| `20260830140000` | Contraofertas solo de precio | Trigger bloquea cambios de moneda, ventana, pago, vigencia y condiciones en revisiones |
| `20260830150000` | Tool de cotización mínima | Solo min/max; moneda y primera ventana autorizada resueltas en servidor; extras ausentes en null, sin borrar historial |
| `20260830160000` | Tope de precio visible solo en contexto interno del agente proveedor | Mismo mandato/pedido autorizado; no se agrega a tools ni listados públicos |
| `20260830170000` | Adjudicación sin veto por ambigüedad del juez | Reemplaza el finalizador de `130000`; conserva revisión vigente y filtros SQL, sin bloqueo por assessment histórico |
| `20260830180000` | Escalaciones durables y evidencia de transcript | El destinatario humano se resuelve desde `handoff_recipients` |
| `20260830190000` | Recibos idempotentes para escalaciones | Habilita `escalate` en el ledger de tools |
| `20260830200000` | Booking vigente y evidencia asociada; retiro de `commitments` | El puntero de la operación se sincroniza con la reserva activa |
| `20260830210000` | Retención de evidencia de llamadas | Transcript y recording de Twilio se purgan al vencer 90 días |
| `20260830220000` | Evento `call.routed` sin operación inicial | El contexto nulo de la llamada y del evento se valida como equivalente |

Los sufijos cortos de la última columna comparten el prefijo `202608300`.
Los comentarios dentro de migraciones viejas describen su momento histórico,
no necesariamente las reglas actuales. Reglas de negocio vigentes:
[decisiones del merge](../docs/provider-sourcing-merge-decisions.md).

La migración de emails es repetible porque una versión anterior había creado sus
objetos. Esa excepción está resuelta: no hay que renumerarla otra vez. El evento
de sourcing se agregó al final para reparar una base ya desplegada; en nuevas
funcionalidades, declarar y confirmar los enums **antes de usarlos en DML**.

## Próximo cambio

1. Crear un archivo `YYYYMMDDHHMMSS_descripcion.sql`, con versión única y posterior
   a todas las existentes. Añadir solo el delta necesario.
2. Crear tipos/columnas antes de funciones dependientes; reemplazar funciones con
   `CREATE OR REPLACE` cuando la firma lo permita. No borrar tablas para recrearlas.
3. Mantener RLS/grants y no reabrir RPCs retirados. Preservar datos y recibos históricos.
4. Actualizar `contracts/schema.sql` si cambian tablas, restricciones o enums.
5. Ejecutar desde la raíz:

   ```bash
   npm --prefix backend run db:check
   npm --prefix backend run harness:migrations
   npm --prefix backend run harness:sourcing
   npm --prefix backend run typecheck
   ```

6. Pushear y comprobar el check de Supabase antes de anunciar que el cambio está
   aplicado. Un push exitoso por sí solo no demuestra un despliegue exitoso.
7. Tras verificar la aplicación, extender el lock con las nuevas migraciones,
   conservando intactas sus entradas anteriores.

`db:check` es estático: verifica el baseline, versiones, tablas de referencia,
eventos declarados y nombres de RPCs usados en los repositorios/servidor. **No es
un parser SQL completo ni prueba ejecución, orden interno, firmas, permisos o
concurrencia PostgreSQL.** No conecta a Supabase, usa `.env`, aplica SQL ni hace seed.
