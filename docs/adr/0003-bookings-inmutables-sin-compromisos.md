# ADR 0003 — Bookings inmutables sin Compromisos

**Estado:** aceptado
**Fecha:** 2026-08-30

La reserva y su historia se representan exclusivamente con Bookings inmutables: cada selección o reprogramación crea un Booking y `operations.current_booking_id` identifica el vigente; una cancelación deja esa referencia en `NULL`. Se elimina la entidad Compromiso porque duplicaba los términos y la evidencia de una Llamada sin producir un efecto operativo distinto; los Eventos conservan las transiciones y el Booking referencia la evidencia conversacional cuando corresponde.
