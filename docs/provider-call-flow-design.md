# Redefinición de llamadas de Proveedores

Plan consolidado del MVP, 2026-08-30. Registra acuerdos de la entrevista;
no describe cambios ya implementados ni autoriza un despliegue.

El desglose técnico y las asignaciones están en
[provider-call-flow-implementation-plan.md](provider-call-flow-implementation-plan.md).
HITL y llamadas ya fueron probados por el usuario: se conserva esa implementación.
Por pedido explícito, el trabajo end to end excluye pruebas, harnesses, QA y
llamadas de validación; se limita a implementar e integrar el cambio completo.

## Decisiones acordadas

- La dirección se define desde Tango: entrante si llama la contraparte,
  saliente si llama Tango. Se mantiene durante toda la conversación y es
  independiente del propósito y de la intención.
- Separar los contextos y las tools de gestión de Bookings de los de
  cotización. La entrada de gestión ofrece listar los Bookings propios,
  elegir modificar o elegir cancelar; no ofrece escalación inicialmente.
- En el MVP, una llamada entrante del Proveedor no habilita cotización,
  incluso si devuelve una llamada saliente de Tango. Retomar una cotización
  pendiente en una llamada entrante queda fuera de alcance.
- El Proveedor debe elegir explícitamente que quiere modificar e identificar
  el Booking antes de ejecutar un cambio. Seleccionar intención y Booking
  no modifica la reserva ni equivale a confirmar el cambio.
- La modificación automática se limita a fecha y horario de retiro dentro
  de lo autorizado por el Cliente. Cambios de precio, recorrido u otras
  condiciones requieren revisión humana, sin aplicarlos automáticamente.
- Tras seleccionar el flujo, se recoge el cambio concreto, se resume y se
  obtiene confirmación explícita antes de aplicarlo. La escalación puede
  habilitarse después de elegir modificar o cancelar, sin exigir ejecutar
  primero la modificación o la cancelación.
- Si el Proveedor pide hablar con una persona desde el inicio, Tango debe
  obtener primero la selección del Booking y de la acción (modificar o
  cancelar). Solo con ambas selecciones se habilita la escalación; pedir
  una persona no permite omitir este paso ni inferir una acción no elegida.
- En el MVP se gestiona un único Booking y una única acción por llamada.
  Al terminar esa gestión se cierra la llamada; gestionar otro Booking u
  otra acción requiere una nueva llamada.
- La cancelación del Proveedor cancela solo su Booking. La Operación del
  Cliente se mantiene abierta, pendiente de conseguir un reemplazo.
- La búsqueda de reemplazo vuelve a contactar primero a los Proveedores que
  habían cotizado la Operación sin ser elegidos y suma un Proveedor nuevo.
  Se excluyen el que canceló y quienes ya rechazaron el trabajo. Se requiere
  una nueva confirmación de disponibilidad y precio, no una adjudicación
  basada únicamente en la Cotización anterior.
- Con dos cotizantes originales y uno adjudicado que cancela, los candidatos
  de reemplazo son el otro cotizante y un Proveedor nuevo, si están disponibles.
- Si la búsqueda de reemplazo no consigue una Cotización válida, la Operación
  queda abierta, sin más rondas automáticas. Marcarla pendiente de revisión
  humana si puede reutilizarse un mecanismo simple existente; no agregar un
  flujo complejo de revisión para el MVP.
- El límite general para llamadas salientes a un Proveedor es de una llamada
  inicial y hasta dos reintentos: tres llamadas como máximo. Aplica también
  fuera de la búsqueda de reemplazo. Solo se reintenta si no atiende
  (`no-answer`); ocupado, rechazo explícito, error o corte después de atender
  no habilitan una nueva llamada automática por esta política.
- Todas las propuestas de precio del Proveedor se guardan como eventos,
  independientemente de estar dentro o fuera de rango. Incluye oferta inicial,
  contraofertas y propuestas no aprobadas. Registrar no significa aceptar ni
  crear un Booking; las Cotizaciones confirmadas conservan sus versiones y eventos.

## Flujo de recuperación a implementar

1. Confirmar la cancelación con el Proveedor y cancelar únicamente su Booking.
2. Registrar trabajo pendiente de búsqueda junto con la cancelación, de forma
   que reintentar el mismo comando no duplique la búsqueda ni las llamadas.
3. Cerrar la gestión entrante. El backend inicia llamadas salientes separadas
   para obtener nuevas Cotizaciones de reemplazo bajo el Mandato vigente.
4. Reutilizar la negociación y selección de Cotizaciones, verificando las
   condiciones actuales. No asumir que una Cotización anterior demuestra
   disponibilidad actual ni readjudicar el Booking cancelado.
5. Crear un nuevo Booking solo con una Cotización válida y autorizada para
   selección. Conservar la historia de la cancelación y de ambas búsquedas.
6. Si se agotan los candidatos y sus reintentos sin una Cotización válida,
   mantener la Operación abierta y pendiente de revisión humana, sin iniciar
   otra ronda automática.

El plan no implica llamadas reales ni cambios de código ya realizados.

## Revisión humana simple

Existe el estado `needs_follow_up`, considerado abierto y visible en los filtros
de atención de Operations. La transición desde `sourcing` ya está permitida.
Reutilizarlo cuando se agote la búsqueda de reemplazo, sin crear una escalación
telefónica ni iniciar notificaciones o llamadas. Falta implementar la conexión
entre el fin de esa búsqueda y el cambio de estado; no ocurre automáticamente hoy.

## Criterios simples propuestos para la implementación

- Elegir al Proveedor nuevo al azar entre los activos elegibles, conservando
  la selección aleatoria existente y las exclusiones acordadas. Si no hay
  otro disponible, continuar solo con los candidatos existentes.
- Espaciar los reintentos por un minuto y contar el máximo por Proveedor y
  búsqueda. Persistir contador y próximo intento para no reiniciarlos al
  reiniciar el servidor. Cancelar contactos pendientes si ya hay reemplazo.
- Identificar cada búsqueda por separado: una recuperación bajo el mismo
  Mandato necesita solicitudes, plazo y claves idempotentes propios. No
  crear un Mandato nuevo ni reabrir solicitudes históricas canceladas.
- Conservar la negociación, selección y emails de adjudicación existentes.
  No agregar notificaciones de cancelación/reprogramación en este cambio.
- No considerar agotada una búsqueda con conversaciones o reintentos todavía
  pendientes. Conservar la ventana de comparación existente para seleccionar
  propuestas válidas, con el reloj correspondiente a la nueva búsqueda.

Estos criterios completan detalles operativos sin ampliar el alcance; no se
presentan como respuestas explícitas del usuario. La ronda de preguntas se
cierra por su pedido de simplificar y avanzar.

## Orden de implementación

1. Separar perfiles, contexto y autorización por dirección y propósito.
2. Incorporar la selección de Booking e intención sin mutar la reserva y
   habilitar escalación únicamente después de ambas selecciones.
3. Conectar cancelación con búsqueda de reemplazo y reintentos persistidos.
4. Conectar búsqueda agotada con `needs_follow_up`.
5. Incorporar registro inmediato de cada propuesta de precio como evento,
   sin filtro de rango, separado de la aprobación y adjudicación.
6. Integrar los componentes sobre el SDK, telefonía y HITL existentes, sin
   agregar una etapa de pruebas ni volver a validar los flujos ya probados.
