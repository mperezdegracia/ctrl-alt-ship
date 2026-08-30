# Worker de contactos salientes

El backend mantiene un `OutboundSourcingLoop` async dentro del proceso HTTP. Cada
tick consulta el Outbox durable y delega un contacto a
`ProviderContactWorker.runOnce()`. El loop no es la fuente de verdad del estado:
leases, intentos, slots, ritmo, callbacks y retries viven en SQL.

## Ciclo durable

1. `claim_next_provider_contact_v2` devuelve `null` o un job escalar con `call_id`,
   `lock_token`, ronda, request, propósito y `attempt`.
2. `begin_provider_contact` revalida operación, Mandato, proveedor, ronda, request,
   expiración y permiso de marcado. Solo `{ should_dial: true }` habilita el POST.
3. El worker reutiliza `createTwilioOutboundCall` con el `calls.id` ya persistido.
   No inserta otra llamada ni inventa un intento en TypeScript.
4. `finish_provider_contact_v2` guarda el SID o recibe el error clasificado como
   `definite/ambiguous`; el worker actual usa `ambiguous` conservadoramente. Si falla la persistencia del SID, se reintenta guardar el
   mismo SID; nunca se repite el POST.
5. `advance_sourcing_round` conserva la finalización comercial y determina trabajo
   pendiente, agotamiento o `needs_follow_up`.

Los reintentos telefónicos son exclusivamente SQL: hasta tres llamadas por
request/proveedor/ronda, separadas 60 segundos, únicamente ante `no-answer` sin
evidencia de atención. Busy, failed, canceled, completed, rechazo verbal y error
de POST no programan otra llamada. Un dispatch ambiguo sin SID o callback después
de dos minutos queda para revisión; no se convierte en `no-answer`.

El callback de Twilio es la autoridad para el resultado telefónico. `in-progress`
y `completed` prueban atención; el resultado comercial de `calls.outcome` no se
reemplaza por un estado telefónico. La correlación usa el `calls.id` persistido y
el SID; la secuencia y los duplicados se resuelven monotónicamente en SQL.

`OutboundSourcingLoop` puede continuar en polling cada cinco segundos y no espera
el fin de la conversación. El worker no usa timers en memoria para retries. El
reinicio del proceso deja los trabajos durables para recuperación de lease, sin
redespachar una llamada que ya está en `dispatching`, `accepted` o `unknown`.

## Runbook de activación (no ejecutar desde este documento)

La activación requiere autorización explícita y un responsable del entorno:

1. Acordar una ventana de mantenimiento y el mecanismo operativo de pausa antes
   de tocar DB. No existe endpoint/flag de pausa independiente: el loop vive en
   el proceso HTTP y detener Render también corta sus sesiones. Por eso no se
   puede prometer drenaje seguro con un simple restart; el responsable debe
   autorizar y coordinar la suspensión de nuevas entradas/trabajos y el drenaje.
2. Drenar las llamadas antiguas y registrar los jobs/callbacks todavía en vuelo.
3. Aplicar las migraciones forward-only en orden: `M0 → MB → M1 → M2 → M3`.
4. Desplegar un backend compatible con las RPC v2 y el worker nuevo.
5. Retirar el worker/rutas antiguas, reanudar el dispatch y observar logs durables.

`backend/render.yaml` declara un servicio web Render, `npm start` y
`autoDeployTrigger: commit`, filtrado a `backend/**`. La configuración remota y
la pausa de autodeploy deben confirmarse antes de publicar. El workflow de migraciones
observado ejecuta checks/harnesses, no aplica DB remota ni coordina
atomicidad entre migración y backend. No aplicar migraciones, desplegar, drenar
llamadas reales ni reanudar dispatch como parte de este runbook documental.

El baseline `20260830200000_bookings_replace_commitments.sql` debe inspeccionarse
antes de activar una instalación fresca; cualquier bloqueo de aplicación requiere
resolución autorizada sin editar silenciosamente la migración histórica.

Verificación de este documento: revisión estática solamente; no se ejecutaron
migraciones, tests, QA, llamadas ni despliegues.

## Incidente inbound: `event references another operation`

Los logs aportados del 2026-08-30 09:12:09Z muestran fallo `23514` en
`call.routing_persist_failed`, seguido de rechazo SIP 603. La llamada inbound se
crea sin Operación hasta que el usuario seleccione; su evento `call.routed`
también tiene `operation_id=NULL`. El validador del baseline 200000 usa `=`, por
lo que no encuentra coincidencia entre ambos NULL. Su constraint de eventos
también omite el caso `call.routed` sin Operación.

MB (`20260830211000_immutable_booking_commands.sql`, commit `43b8015`) ya
restaura el caso permitido y usa `IS NOT DISTINCT FROM`, sin aceptar vínculos a
otra Operación. No asignar arbitrariamente una Operación ni omitir el evento
para evitar el error. Este arreglo está versionado localmente; los logs no
demuestran qué migraciones están aplicadas remotamente. ACT-01 debe resolver
esa diferencia de versiones antes de reanudar llamadas.
