# Alta mínima y fecha actual

Decisión del usuario, 2026-08-30: pedir solo lo mínimo para iniciar la búsqueda.

## Obligatorio para el cliente

- Origen y destino, suficientemente claros para identificar la ruta.
- Presupuesto máximo y moneda.
- Fecha y ventana local de retiro autorizada.

Un ejemplo con los datos esenciales: «Necesito retirar del puerto de Buenos Aires
y llevar a González Catán el 2 de septiembre, de 10 a 14, hasta 950 mil pesos
argentinos». El agente guarda la ruta y pide una única confirmación breve para
pedido, condiciones y autorización de búsqueda. No inventa un rango horario si
el cliente solo indicó un día: pregunta ese dato faltante.

## Tools sin campos opcionales de negocio

`create_operation` y `update_operation.changes` exponen solo `pickup_location` y
`delivery_location`. El borrador permite datos parciales; para confirmar se exigen
ambos. En edición se envían solo los campos cambiados y `operation_reference`
cuando hay que seleccionar el pedido. `confirm_mandate` expone solo `price_cap`,
`currency` y `action_windows`; en actualización permite omitir términos heredados.

Contenedor, peso, devolución del vacío, plazo de pago, notas y restricciones no se
preguntan ni se ofrecen como argumentos. No se borran columnas ni valores previos:
el backend conserva datos históricos. Si el cliente menciona una condición material
no soportada, explicar la limitación y ofrecer ayuda humana, sin prometer guardarla
ni confirmar un acuerdo que la ignore. Este recorte de schemas no requiere SQL nuevo.

Omitir pago en el primer mandato usa `minimum_payment_term_days = 0` como ausencia
de un mínimo impuesto por el cliente. No significa que se acordó pago inmediato:
la cotización mínima deja el plazo en null, sin pedirlo. Si el mandato ya tiene un
mínimo explícito positivo se conserva como término fijo del pedido. En updates se
hereda el mínimo vigente; esta tool de voz ya no permite modificarlo.

La migración `20260830120001` alinea campos faltantes, snapshots y trigger de
operación, y reemplaza el RPC cliente conservando recibos/idempotencia. La selección
solo exige compatibilidad de equipo si el cliente especificó equipo. Precio,
moneda, ventana, condiciones y límites explícitos siguen validándose. Los emails
admiten equipo/peso desconocidos sin sustituirlos por datos ficticios.

## Fechas

El prompt compartido incorpora fecha, día de semana y año calculados por el reloj
del servidor, con referencia del demo en Buenos Aires y fecha UTC. No se hardcodea
2026 ni se usa el año de ejemplos. La localidad del retiro rige los timestamps.
Sin año, se usa el actual; un año explícito o una fecha verificada prevalece.
Fechas pasadas, inválidas o contradictorias se aclaran sin saltar al próximo año.

## Alcance frente al challenge adjunto

Esto simplifica el alta, no acredita cumplimiento completo del challenge. Siguen
pendientes diferencias conocidas: hoy se contacta a dos carriers, no tres; no se
usan ofertas ajenas en la negociación; hay que demostrar recap escrito enviado,
vínculo de cada compromiso a un timestamp de audio, call brief y entrega efectiva
del contexto al humano. No se agregaron esos comportamientos en este cambio.

No se ejecutaron tests, llamadas ni migraciones contra una base en esta tarea.
Aplicar la migración junto con el backend antes de validar una llamada mínima.
Guía consultada: [OpenAI, prompting Realtime](https://developers.openai.com/api/docs/guides/realtime-models-prompting).
