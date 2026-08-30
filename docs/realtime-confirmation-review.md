# Decisión: Agents SDK y confirmación conversacional

Fecha: 2026-08-30. Acordado con Lucas; reemplaza la decisión anterior de mantener
el tracker de evidencia mientras se diagnosticaba la ausencia de confirm_mandate.

## Qué cambia

- Runtime: @openai/agents 0.17, RealtimeAgent + RealtimeSession + OpenAIRealtimeSIP.
  El SDK maneja ejecución de tools, resultados, continuación e historial.
  El paquete openai permanece para verificar webhooks y aceptar/rechazar llamadas.
- Una sesión por llamada SIP existente, conectada por callId. No se abre otra llamada
  ni se duplica el audio que transporta Twilio.
- Sin needsApproval, solicitudes de aprobación UI ni ConfirmationEvidenceTracker.
  No se espera audio_end, transcripción o buffer drenado para habilitar un mandato.
- Se mantiene OOP: AgentsCallSession adapta las tools existentes a la sesión;
  servicios y repositorios conservan las reglas de negocio.
- El modelo sigue siendo gpt-realtime-2.1, reasoning low, voz cedar, velocidad 1.05.
- Ambas personas reciben primero: “Hi, this is Tango, your logistics assistant.
  How can I help you today?”. Se solicita al conectar, sin esperar al usuario.
  Después se usa el idioma del usuario, incluida la confirmación del mandato.

## Flujo de cliente vigente

| Estado | Tools disponibles |
| --- | --- |
| Entrada, sin operación elegida | list_open_operations, create_operation, update_operation |
| Pedido creado o seleccionado mediante una edición | update_operation, confirm_mandate |
| Mandato confirmado / llamada terminal | Ninguna mutación |

Los perfiles client_create, client_update y client_confirm siguen describiendo
el estado, pero todos los perfiles con una operación vinculada exponen el mandato.
No se agrega una tool de selección: la primera edición selecciona la OP existente.
No se implementa cancelar en este cambio ni se exponen tools futuras sin handler.

Para un primer mandato, el agente completa los campos físicos con update_operation,
recoge precio máximo, moneda, ventanas con zona horaria y pago mínimo, lee el resumen
completo y espera un sí explícito en el turno siguiente. Recién entonces confirma.
No debe guardar términos comerciales en operational_constraints o cargo_notes.

### Modificar: confirmar solo las diferencias

Si el camino es update y ya existe un mandato, no volver a pedir ni recitar los
términos que no cambian. Ejemplo: “Cambio el destino de Pilar a Escobar; el resto
queda igual. ¿Confirmás?”. El sí autoriza el cambio, sin repetir precio, pago y horario.

Una sola confirmación cubre el conjunto de cambios del envío y del mandato.
Si se cambian destino, máximo y pago, se resumen juntos y ese mismo sí debe
disparar confirm_mandate con todos los términos comerciales cambiados, sin una
segunda pregunta para el mandato. Los datos físicos ya se guardaron mediante
update_operation; no se envían como argumentos del mandato. Esto es una única
confirmación conversacional, no una transacción conjunta de ambas tools.
El agente no da por finalizada la modificación hasta recibir éxito y la nueva
mandate_version. Si confirmar falla, explica que puede haber datos operativos
guardados pero que el nuevo mandato aún no está confirmado.

El estado del servidor incluye currentMandate (términos/version, sin IDs) y
operationChanges (valores antes/después comparados con el snapshot vigente).
Ese contexto es exclusivo del cliente. Se resumen todas las diferencias reales;
si aparece alguna no solicitada, se aclara antes de confirmar. Una corrección
requiere una nueva confirmación de las diferencias, no recitar todo el pedido.

confirm_mandate recibe solo términos comerciales modificados; {} conserva todos.
SQL mezcla el parche con los términos del mandato vigente bajo el lock de operación,
valida el resultado y crea la nueva versión completa. No se rellenan omisiones
desde memoria del modelo. Un action_windows suministrado reemplaza la lista entera;
null, listas vacías y campos desconocidos no significan “mantener” y se rechazan.
El recibo idempotente guarda el parche original, no los valores heredados.

Si no existe un mandato previo, incluso en update, siguen siendo obligatorios todos
los términos y el resumen completo. SQL mantiene el guard de estado y rechaza una
confirmación si no hay reconfirmación pendiente. El cambio operativo sigue exigiendo nueva aceptación del
transportista: solo se acorta la confirmación del cliente, no esa regla de negocio.

## Lo que valida el backend

SQL conserva identidad/autorización, propiedad, camino de la llamada, campos
obligatorios, estado, formato y límites comerciales, revisión actualizada de la
operación y clave de idempotencia original del tool call. IDs internos y revisión
los aporta el servidor, nunca el modelo. Se construye el snapshot desde la fila
bloqueada y se crean versión inmutable, eventos y recibo en una transacción.

Cambios posteriores requieren un nuevo mandato; no se sobrescribe el anterior.
Al confirmar, la llamada queda terminal para mutaciones. Sourcing indica que la
operación está lista: todavía no implica contactar transportistas ni reservarlos.

**Límite aceptado:** el agente interpreta el consentimiento verbal. No hay un
clasificador independiente ni verificación técnica de que el resumen se reprodujo
completo o fue escuchado. La disponibilidad de la tool no prueba consentimiento;
SQL tampoco puede verificar que el humano dijo sí. No se afirma evidencia legal.

## Migración y despliegue

Aplicar primero 20260830020000_conversational_mandate_confirmation.sql mediante el
flujo de migraciones del proyecto. Reemplaza la función existente sin cambiar su
firma ni sus permisos service_role. La migración anterior no se reescribe.

confirmation_evidence se conserva como columna histórica nullable: no se borran
registros previos y los nuevos mandatos no la completan. No se generan evidencias
ficticias ni se escribe un checkpoint de grabación Twilio.

Después desplegar backend con sus nuevas dependencias y CLIENT_OPERATION_TOOLS_ENABLED=true.
No usar el nuevo backend sobre la función vieja: respondería confirmation_not_ready.
La migración no se ejecutó contra Supabase desde esta tarea. No se hizo push ni deploy.
El último pull integró origin/main hasta fcfe5c9, incluidos los cambios de dashboard
y escalamiento. Los cambios locales de esta migración se conservaron sin conflictos.

Actualización posterior: para confirmación por diferencias, aplicar también
20260830030000_incremental_mandate_confirmation.sql antes del backend nuevo.
Extiende el estado de cliente y permite parches comerciales en update con mandato.
No crea tablas ni cambia mandatos históricos. Esta migración adicional no se aplicó
ni se probó contra PostgreSQL desde la tarea; su validación local es estática y con RPC simulado.

## Compatibilidad SDK y observabilidad

- updateAgent actualiza tools e instrucciones antes de devolver el resultado.
- El adaptador preserva tools: [] explícito: SDK 0.17 omite listas vacías y una
  omisión en session.update dejaría las herramientas previas en el servidor.
- El helper de tools tipa strict:false con additionalProperties:true; el adaptador
  restaura el schema cerrado del contrato antes de exponerlo. Mantiene campos
  opcionales y validación estricta de datos en servicios/SQL.
- El ID original de la invocación viene de los detalles del SDK. SQL conserva
  replay durable. El SDK también deduplica dentro de una respuesta activa; no se
  promete replay transparente de frames tardíos después de cambiar de perfil.
- El escalamiento a supervisor conserva su farewell y usa backgroundResult para
  evitar una respuesta automática duplicada. El buffer SIP solo se observa para
  transferir después del farewell, no para autorizar mandatos.
- Sin tracing externo adicional ni copia de audio en el historial.
- Logs info: tool.requested/completed/failed, realtime.session_update_requested,
  realtime.session_created/updated, realtime.greeting_requested y conexión.
  Los logs comparan nombres de tools y hashes del prompt; session.updated no es un
  ACK correlacionado por event_id. No se registran transcripciones al nivel info.
- Se retiraron el tracker y su harness de audio; son recuperables del historial Git.

## Validación

Harnesses locales con SDK real y socket/repositorio simulados: conexión SIP,
configuración inicial, saludo, schemas, cambios de perfil antes de continuar,
mandato sin evidencia/approval, rechazo de datos incompletos, historial, retirada
terminal de tools y una única despedida al escalar. Servicios: argumentos,
identidad, errores públicos y contexto SQL sin evidencia.

No son pruebas de PostgreSQL, concurrencia real, audio telefónico ni precisión
de consentimiento. Para eso seguir [el guion de Lucas](client-tools-lucas-test.md)
después de desplegar, incluyendo una negativa y una corrección antes del sí final.

Referencia oficial: [Voice agents / Agents SDK](https://developers.openai.com/api/docs/guides/voice-agents).
