# Evidencia de la llamada

El botón **Evidencia** del detalle de la operación abre una página dedicada.
Permite elegir una llamada y leer su transcript completo en una vista continua,
con tiempo relativo, interlocutor y texto a la izquierda, y los eventos al costado.
En pantallas pequeñas los eventos se acomodan debajo del fragmento correspondiente.
Se usan los colores, tipografías y estilos del dashboard existente.

El endpoint autenticado `GET /api/dashboard/operations/:reference/evidence?call=UUID`
solo lee `operations`, `calls`, `contacts`, `providers`, `call_transcript_segments`
y `events`. No cambia tablas, permisos, migraciones ni cotizaciones. La llamada
solicitada debe pertenecer a la operación; una llamada ajena devuelve 404.
El texto no se carga en la página principal ni se precarga al pasar sobre el botón.

Las consultas recorren internamente todas las páginas de PostgREST para no cortar
transcripts de más de 1.000 segmentos. No hay paginación visible del transcript.
El botón Actualizar vuelve a consultar los registros disponibles, también durante
una llamada activa. Los segmentos eliminados por retención muestran un aviso y
conservan su horario, sin reconstruir contenido.

Cada evento de la llamada se alinea con el segmento más cercano hasta 30 segundos.
La proximidad es aproximada, no prueba consentimiento ni sustituye los enlaces
durables. Los eventos posteriores o sin segmento cercano conservan su horario.
Los eventos de la operación sin llamada asociada también aparecen, identificados
como tales, sin atribuirlos al interlocutor. No se incluyen eventos de otra llamada.
El transcript usa minutos/segundos desde el inicio; la hora de los eventos se
muestra en Buenos Aires (UTC−3). Estos tiempos son de registro, no marcas exactas
de comienzo del audio; no se agregan reproductores ni ondas de audio ficticias.

Pruebas: `npm --prefix backend run harness:evidence` verifica transcript completo,
coincidencias y límites temporales, llamadas ajenas, eventos sin llamada, estados
vacíos, retención y autenticación con una API simulada, sin datos de producción.
