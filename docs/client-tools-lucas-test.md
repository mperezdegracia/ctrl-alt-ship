# Prueba manual de tools de cliente — Lucas

## Preparación

Estas pruebas crean y modifican datos reales. Usar una operación de prueba nueva,
no la fixture compartida `OP-900001`. No volver a ejecutar el seed para esta prueba.

1. Esperar el deploy del backend y comprobar que Supabase haya aplicado
   `20260830010000_client_operation_tools.sql` y
   `20260830020000_conversational_mandate_confirmation.sql` y
   `20260830030000_incremental_mandate_confirmation.sql` y
   `20260830040000_client_cancellation.sql` por el flujo de migraciones del proyecto.
   Un push no demuestra que el deploy o la migración hayan terminado correctamente.
2. Recién después, configurar `CLIENT_OPERATION_TOOLS_ENABLED=true` en el backend
   que recibe las llamadas (Render), y reiniciarlo/redeployarlo. El default sigue
   siendo `false`; cambiar solamente el `.env` local no cambia Render.
3. Para diagnóstico, usar temporalmente `LOG_LEVEL=debug`. Incluye transcripciones
   y términos comerciales: no compartir esos logs públicamente y volver a `info`
   al terminar. En `info` ya se ven herramientas solicitadas, completadas y errores.
4. Llamar desde el número de Lucas registrado por el seed, `+5491163723502`, al
   número de Twilio usado en las pruebas previas. El caller ID debe coincidir
   exactamente con `contacts.phone`; Lucas debe estar activo y autorizado.
5. Abrir los logs del backend. Agrupar eventos por `call_id` y mirar
   `call.routed`, `call.tools_configured`, `tool.requested`, `tool.completed`,
   `tool.failed`, `realtime.greeting_requested` y `realtime.session_updated`.

Si se habilita la bandera antes de aplicar la migración, una llamada puede fallar
al cargar su estado (`call.tool_state_failed`). No es necesariamente un caller ID inválido.
El dashboard lee operaciones reales. Complementar su vista con otra llamada,
los logs y la consulta de solo lectura de abajo.

## Llamada 1 — listar, crear, corregir y confirmar

1. Esperar el saludo inicial en inglés (“Hi, this is Tango…”). Luego hablar en español: «Hola, ¿qué operaciones abiertas tengo?». Tango debe
   responder en español y usar `list_open_operations`, mostrando solo operaciones
   de Lucas. Es normal que incluya la fixture existente.
2. «Quiero crear una operación nueva de prueba: contenedor de 40 pies dry, desde
   Terminal 4 a Pilar». Debe usar `create_operation`, devolver un `OP-…` generado
   por PostgreSQL y pedir faltantes sin inventarlos. Anotar esa referencia.
   En los logs ya deben aparecer update_operation y confirm_mandate, aunque falten datos.
3. Completar a medida que pregunte: peso `24000 kg`, devolución del vacío en
   `Dock Sud`, restricción `entrega con turno previo`, notas `carga no peligrosa`.
   Debe usar `update_operation`. No debe crear una segunda operación.
4. Dar los términos: «El máximo es 950000 pesos argentinos, pago mínimo a 30 días
   desde la factura y retiro el 1 de septiembre de 2026 entre las 10 y las 14,
   hora de Buenos Aires, UTC menos tres». Si esa fecha ya pasó, elegir una fecha
   futura explícita. No asumir que Tango conoce moneda, fecha o zona horaria.
5. Antes de aceptar, decir: «No confirmo todavía; cambiá el peso a 25000 kilos».
   Debe editar y leer un nuevo resumen completo. No debe llamar `confirm_mandate`
   por la negativa o por guardar la corrección.
6. Dejar que termine de hablar y preguntar. En el siguiente turno: «Sí, confirmo
   toda la operación y esas condiciones». Debe llamar `confirm_mandate` una vez.
   Resultado esperado: `status: sourcing`, `mandate_version: 1`, perfil `terminal`.
7. «Ahora creame otra operación» o «cambiá de nuevo el peso». Debe explicar que
   el flujo de esa llamada terminó, sin ejecutar otra mutación. Cortar.

En Supabase: una operación con peso 25000, un mandato v1 con snapshot de esos
datos, vinculado a la llamada y con fecha de confirmación, eventos `mandate.confirmed` y
`sourcing.started`, y un recibo por cada comando ejecutado. No se contacta a ningún
transportista ni se crea un booking por esta prueba.

## Llamada 2 — actualizar y reemplazar el mandato

1. «Quiero ver mis operaciones abiertas». La operación de prueba debe aparecer
   con su referencia y nombre derivado de la ruta.
2. «Quiero actualizar la OP-[referencia anotada]: cambiá el destino a Escobar».
   Debe usar `update_operation` sobre esa operación, bloquear el camino update y
   marcar `mandate_confirmation_required: true`.
3. Tango debe explicar que los nuevos términos requieren otra confirmación y que
   la aceptación anterior de un transportista no autorizaría este cambio.
4. Decir «Solo cambiá el destino, mantené lo demás». No volver a dar precio,
   moneda, ventana ni plazo. Debe preguntar algo como «Cambio el destino de Pilar
   a Escobar; el resto queda igual. ¿Confirmás?», sin recitar los valores anteriores.
   Confirmar en el turno siguiente. confirm_mandate debe recibir {}.
5. Esperado: misma operación/UUID/referencia, mandato v2 que reemplaza v1,
   `mandate_confirmation_required: false`, `status: sourcing` y perfil terminal.
   v1 conserva el destino Pilar; v2 captura Escobar. No se sobrescribe v1.
   Precio, moneda, lista de ventanas y plazo deben ser idénticos a v1.
6. En una llamada adicional, modificar una ubicación y pedir además cambiar
   únicamente el máximo. Debe confirmar esas dos diferencias y enviar solo
   price_cap en confirm_mandate; el resto se conserva desde el mandato vigente.
   Al completar un borrador sin mandato, en cambio, sí debe pedir todos los términos.

## Llamada 3 y 4 — borrador sin confirmar y recuperación

1. En otra llamada: «Creá una operación de prueba con contenedor de 20 pies dry».
   Anotar el nuevo OP y cortar sin completar los datos.
2. Debe quedar en `collecting_details`, sin mandato; los faltantes siguen nulos.
3. Volver a llamar, listar y decir «Quiero completar la OP-[nuevo OP]; el origen
   es Terminal 4». Esa edición selecciona la operación existente. Completar los
   faltantes y confirmar como en la primera llamada; no debe duplicar el borrador.

## Otra llamada — cancelar, con confirmación SMS

Usar únicamente la operación de prueba creada arriba; no cancelar pedidos reales.

1. «Hola, quiero ver mis operaciones abiertas».
2. «Quiero cancelar la OP-[referencia anotada] porque ya no necesito el traslado».
   Debe identificar el pedido y pedir confirmación de cancelación. No debe usar
   `update_operation` ni `confirm_mandate` para esto.
3. Primero responder «No, todavía no». No debe ejecutar `cancel_operation`.
4. Pedir de nuevo la cancelación. Debe resumir referencia y motivo, aclarar que
   cancela en el sistema, encola un SMS de confirmación al cliente y, si había
   Booking confirmado, un SMS operativo al transportista; debe pedir confirmación.
5. En el turno siguiente: «Sí, confirmo cancelar esa operación».
6. Esperado: `cancel_operation` devuelve `status: cancelled`,
   `client_sms_queued`, `provider_sms_queued`, `next_profile: terminal`. El
   agente confirma el resultado y que el SMS fue encolado, sin prometer entrega
   ni pedir otro mandato.
7. Pedir otro cambio: no debe ejecutar mutaciones. En una nueva llamada, el OP
   cancelado ya no aparece entre las operaciones abiertas.

En la base: operación cancelada, booking activo cancelado si existía, eventos
`operation.cancelled` y opcionalmente `booking.cancelled`, llamada con intención
`cancel` y marcador terminal, recibo de la tool. Ninguna nueva versión de mandato,
ningún email ni job de email. Sí hay un job SMS de cliente y, solo con Booking
confirmado, uno de provider. Los mandatos/quotes/compromisos históricos permanecen.

## Controles adicionales

- Durante un resumen, interrumpir con una corrección. Debe rehacer el resumen y
  pedir otra confirmación, no aceptar un sí anterior al cambio.
- Una pregunta («¿incluye el retorno?»), silencio o «no confirmo» no deben crear
  un mandato. La interpretación de consentimiento la hace el agente; ya no existe
  tracking de audio ni un segundo paso de aprobación SDK.
- Si aparece `confirmation_not_ready`, revisar que se haya desplegado la migración
  nueva; el RPC anterior todavía exige evidencia. No pedir repetir el sí en bucle.
- Si aparece `stale_operation`, leer los datos refrescados y pedir nueva confirmación.
- Repetir el saludo con un proveedor autorizado: empieza en inglés y luego cambia
  al idioma del proveedor; no debe exponer tools de cliente.
- Después de elegir create/update, pedir cancelar: debe explicar que ese camino
  ya no está disponible en esa llamada, sin cancelar ni prometer un email.
- No probar idempotencia repitiendo «sí»: eso es un turno nuevo. La idempotencia
  se basa en el mismo ID de invocación técnico y aún requiere validación SQL/entorno.

## Consulta opcional de solo lectura

En el SQL Editor de Supabase, reemplazar `OP-REEMPLAZAR` por la referencia real.
Esta consulta no modifica datos y no expone el texto de la llamada:

```sql
SELECT o.reference, o.status, o.pickup_location, o.delivery_location,
       o.gross_weight_kg, o.mandate_confirmation_required,
       m.version, m.id = o.current_mandate_id AS is_current,
       m.supersedes_mandate_id, m.operation_snapshot,
       m.confirmed_in_call_id, m.confirmed_at
FROM public.operations o
LEFT JOIN public.mandates m ON m.operation_id = o.id
WHERE o.reference = 'OP-REEMPLAZAR'
ORDER BY m.version;
```

La migración y las pruebas SQL no se ejecutaron desde esta tarea. Las pruebas
automatizadas locales usan RPC/socket simulados; la validación telefónica real
y el resto de handlers del issue #13 siguen pendientes.
