# Reparación de `create_quote`: `quotes is append-only`

La versión original de la migración de evidencia (`22ac1c1`, posteriormente
renumerada a `20260830232200`) agregaba columnas de evidencia a `quotes`.
Al insertar el recibo de `create_quote`, el trigger
`attach_provider_quote_evidence` intentaba actualizar esas columnas. El trigger
de inmutabilidad rechazaba ese `UPDATE` con SQLSTATE `55000` y revertía el comando
completo, incluida la nueva quote.

El remoto reemplazó ese código dentro de la migración histórica. Eso corrige
instalaciones nuevas, pero no actualiza una base que ya aplicó la versión original.
El log reportado coincide con esa versión; no se inspeccionó ni modificó producción.

La nueva migración `20260830232500_preserve_quote_immutability.sql` repara ambos
estados de la base sin desactivar `quotes_append_only` ni modificar migraciones
históricas. `create_quote` sigue insertando una nueva versión que referencia la
anterior mediante `supersedes_quote_id`.

La evidencia es un enlace al segmento ya existente del transcript, no una copia
del texto. Se inserta en `quote_transcript_evidence` y se asocia a la versión del
recibo, sin depender del último evento de la llamada. El booking toma el enlace
de la quote seleccionada. Los replays no duplican cotizaciones; si no se recibió
un segmento, no se inventa evidencia ni se impide crear la quote.

Si la base conserva las columnas antiguas, la migración copia los enlaces válidos
a la tabla separada y deja las columnas intactas. También corrige la ambigüedad
entre la variable `quote_id` y la columna del `ON CONFLICT` presente en la versión
del remoto. Cotizaciones y enlaces de evidencia rechazan actualizaciones y borrados.

Aplicar las migraciones pendientes en orden antes del despliegue. No alcanza con
reiniciar el backend ni con volver a editar la migración histórica.

Verificación desde `backend` (Docker local, PostgreSQL 16 desechable, sin red,
puertos publicados, credenciales ni datos de producción):

```sh
npm run harness:quotes:above-budget:sql
npm run harness:quotes:legacy-evidence:sql
```

El segundo comando instala la versión original como fixture, reproduce el error
exacto y aplica la reparación. Ambos prueban revisiones inmutables, aprobación
fuera del tope, asociación del transcript, idempotencia y evidencia en el booking.
