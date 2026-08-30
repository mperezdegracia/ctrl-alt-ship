# Disposición segura de evidencia — contrato de implementación

Alcance autorizado: corregir retención y callback; pruebas locales sin DB remota
ni solicitudes reales a Twilio. No cambiar plazo de 90 días ni Bookings históricos.

## SQL y RPC

Migración forward `20260830230000_safe_call_evidence_retention.sql`.

- `calls.transcript_purged_at`, `calls.retention_checked_at`: timestamps nullable.
- `call_transcript_segments.content` nullable, `content_deleted_at` nullable.
  Contenido presente XOR borrado marcado. Conservar todos los IDs y metadata.
  Insert tardío de llamada vencida queda tombstone; ningún UPDATE puede restaurarlo.
- `call_recordings`: `recording_sid` PK, `call_id` FK, `status` en
  `in-progress/completed/absent/failed`, `deleted_at`, `deletion_error`,
  `last_attempt_at`, `created_at`. Metadata sin URL/audio. Cada SID se conserva:
  múltiples callbacks/grabaciones no se pisan. Backfill desde calls.recording_sid.
- Ampliar `calls.recording_status` con `deletion_pending`. Campo agregado legacy,
  no autoridad de reintento. Mantener SID después del borrado para idempotencia.

RPCs solo service_role, SECURITY DEFINER y search_path cerrado:

1. `record_call_recording_status(p_twilio_call_sid text, p_recording_sid text,
   p_status text) → jsonb {persisted:true, expired:boolean}`. Exige llamada existente,
   SID CA/RE válidos y estado documentado. SID obligatorio para completed/in-progress;
   optional para absent/failed. Bloquear llamada antes de grabación. Callback
   duplicado o tardío no revive SID eliminado ni degrada completed a in-progress.
   Otra grabación en llamada vencida queda deletion_pending, nunca disponible.
   Rechazar SID ya asociado a otra llamada. No guardar RecordingUrl.
2. `claim_call_evidence_retention(p_limit integer default 100) → jsonb array`
   de `{call_id, transcript_pending:boolean, recordings:[{recording_sid}]}`.
   Solo llamadas vencidas con texto pendiente o grabaciones completed sin deleted_at.
   Reservar llamada con FOR UPDATE SKIP LOCKED y retention_checked_at (lease cinco
   minutos), ordenando primero nunca atendidas/más antiguas para evitar starvation.
   Una llamada sin SID no se considera audio eliminado. No incluir absent/failed/
   in-progress para DELETE, ni audios borrados. Independiente de recording_status legacy.
3. `purge_expired_call_transcripts(p_call_ids uuid[]) → void`: firma existente,
   ahora vacía texto, marca content_deleted_at y transcript_purged_at; por vencimiento
   de llamada, no antigüedad individual del segmento. Bloquea llamada antes de
   segmentos. No DELETE, sin tocar Booking ni evadir FK, sin flags de bypass generales.
4. `complete_call_recording_deletion(p_call_id uuid, p_recording_sid text,
   p_error text default null) → jsonb {persisted:true}`. Solo vencidas y SID propio.
   null significa confirmación del worker (HTTP204 o404); error conserva pending/SID.
   Éxito idempotente y monotónico: error posterior no revierte deleted_at.
   Estado agregado deleted solo sin otras grabaciones pendientes, limpiar recording_url.

## Worker / callback

Worker reclama una tanda, purga texto por llamada y borra cada audio de manera
independiente. Falta de credenciales, HTTP error o timeout => guardar error seguro,
conservar SID y continuar. HTTP204/404 => completar ese SID. Fallo de persistencia
permite reintento idempotente, nunca declarar éxito. Guard local evita solapamiento;
poll de cinco minutos para retomar leases, sin startup bloqueante. Fetch inyectable
para pruebas y timeout finito. No imports de configuración con secretos en harness.

Handler HTTP valida forma, AccountSid, CA/RE y estado, firma sobre URL completa;
await RPC antes de204, error persistencia/correlación ausente =>5xx reintentable.
Inyección de verificador y repositorio para harness. Server solo hace wiring.

Los lectores excluyen tombstones: nunca mostrar null como transcript real.
Esta corrección no completa UI de evidencia expirada ni la política de intentos sin
interacción. La validación debe cubrir fallos parciales, callbacks tardíos y FK.

## Ejecución y latencia

La limpieza corre en segundo plano, fuera del flujo de voz y de las herramientas
del modelo. No agrega consultas al modelo ni espera a Twilio durante conversación.
El único await HTTP nuevo está en el webhook independiente de recording-status,
antes de responder a Twilio. El worker reclama hasta 100 llamadas por tanda y hace
I/O asíncrono; comparte recursos de DB, por lo que no se promete impacto cero.

Se conserva el plazo existente de 90 días. No se ejecutó borrado real, migración
remota, push ni despliegue. La migración debe desplegarse antes del nuevo runtime.
Estados legacy deleted con SID conservado se vuelven a verificar mediante DELETE
idempotente; si el worker anterior ya perdió el SID, esta migración no lo recupera.

La API de [Recording de Twilio](https://www.twilio.com/docs/voice/api/recording)
documenta DELETE exitoso con HTTP204 y solo para recordings completed. Se acepta
HTTP404 como ausencia ya confirmada para reintentos. Nunca convertir in-progress
en completed para adelantar el borrado.

Pruebas locales: `npm --prefix backend run harness:retention:worker`,
`harness:retention:callback` y `harness:retention:sql`. Las dos primeras usan dobles;
la última requiere la imagen local postgres:16-alpine y crea un contenedor
descartable sin red, puertos ni volúmenes de datos del usuario.

## Estado de validación al cierre

Pasaron los harnesses aislados del worker y callback, `db:check` y
`harness:migrations`. Las 37 migraciones se aplicaron a PostgreSQL 16 descartable.
La última ejecución del fixture funcional SQL falló al preparar el snapshot de
Mandate; el fixture quedó en revisión y no se declara aprobado. Se detuvo la
validación adicional por pedido del usuario.

El typecheck general no pasa: reporta errores en harnesses del flujo de Proveedores
y en `call-tool-factory.ts` / `provider-booking-tool.ts`, fuera de estos cambios.
No se considera una validación completa para despliegue.
