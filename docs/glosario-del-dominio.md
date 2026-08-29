# Notas de operación

> El glosario canónico vive en [`CONTEXT.md`](../CONTEXT.md) en la raíz del
> repo. Este archivo conserva solo las notas operativas.

## Estados de una operación

```text
draft
  -> collecting_details
  -> sourcing
  -> quotes_received
  -> quote_selected
  -> booking_pending
  -> booking_confirmed
  -> notifications_sent

sourcing / booking_pending -> needs_follow_up | cancelled | failed
booking_confirmed / notifications_sent -> sourcing  # cancelación del provider
```

Para el demo, `quotes_received` puede comenzar cuando llega la primera oferta
válida. El sistema no debe requerir que respondan todos los proveedores para
seguir; usa un timeout declarativo.

Una reprogramación aceptada actualiza el booking sin abandonar
`booking_confirmed`. Una cancelación del provider puede reabrir una operación
ya notificada y devolverla a `sourcing`; los emails enviados y compromisos
anteriores permanecen como historia.

## Datos que el agente de cliente debe confirmar

- Puerto/terminal de retiro y dirección de entrega (con localidad).
- Fecha o ventana de retiro, restricciones de turno y contacto en origen.
- Tipo de carga: contenedor/bultos, dimensiones, peso y necesidades especiales.
- El mandato: tope de precio con moneda, una o más ventanas de acción y plazo
  mínimo de pago desde factura, confirmados verbalmente.
  Carlos cierra todo en esa llamada; no hay aprobación posterior. El email
  final es confirmación de lo hecho, no un pedido de aprobación.

Si un dato crítico falta, el agente lo pregunta o deja la operación en
`collecting_details`; nunca inventa un valor.

## Fixture del demo

- **Empresa:** Textiles del Plata, importadora textil (eco de "Textiles
  Pacífico" del enunciado).
- **Carga:** contenedor 40' dry, ~24 t brutas, textil paletizado. Sin
  refrigerado, sin IMO, sin sobredimensión.
- **Ruta:** terminal del Puerto de Buenos Aires (p. ej. Terminal 4) → depósito
  en González Catán (dirección fija inventada).
- **Moneda:** ARS. Tope de ensayo: $950.000.
- **Datos que exige un fletero para cotizar:** terminal de retiro, localidad
  de entrega, tamaño/tipo de contenedor, peso bruto, ventana de retiro,
  restricción de turno en destino y depósito de devolución del vacío (fijo,
  no se negocia).
- **Presión narrativa:** los días libres de demurrage vencen al final de la
  ventana de acción — eso explica el límite del mandato en cada escena.

## Idiomas

- **Voz:** espejo del interlocutor, español por defecto. El cambio ES↔EN en
  la misma llamada es el bonus del challenge, no un riesgo.
- **Pantalla:** dashboard, emails, eventos y pitch en inglés (la presentación
  es en inglés).
- **Datos del fixture:** los términos técnicos y nombres de campos en inglés
  (`gross_weight`, `container_type`, `pickup_window`, `empty_return_depot`,
  `price_cap`); los nombres propios en español (Textiles del Plata, Carlos,
  González Catán, Terminal 4). Regla rápida: si es schema/etiqueta → inglés;
  si es un valor con identidad → español.
- Pendiente: confirmar con la organización el idioma del juez del trial by
  fire; si es English-only, ensayar las escenas en inglés.

## Auditoría

- La grabación de llamadas de Twilio queda activada.
- Los eventos relevantes marcan checkpoints temporales para poder reproducir
  la porción de la llamada que produjo cada compromiso.
- Los compromisos son inmutables. Una reprogramación o cancelación crea uno
  nuevo con referencia al compromiso reemplazado; nunca edita el anterior.
- Las propuestas de un proveedor se conservan como versiones de cotización,
  incluso cuando quedan fuera del mandato. Sólo una versión aceptada produce
  un compromiso.
