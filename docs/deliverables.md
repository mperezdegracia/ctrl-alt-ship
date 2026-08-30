# Entregables de demo

Este archivo es el checklist de cierre. No publica nada ni requiere GitHub
Pages: todos los materiales están versionados en este repositorio.

| Entregable | Evidencia en el repo | Estado / último paso humano |
| --- | --- | --- |
| README que se pueda seguir sin contexto | [README](../README.md) y [runbook](demo-runbook.md) | Listo localmente. Confirmar el flujo desde una máquina nueva antes del evento. |
| Demo desde un inicio limpio | `npm run demo:prepare` prepara `OP-900001`, valida Supabase y el runtime | Listo y ejecutado localmente. Falta una llamada real de ensayo. |
| Diagrama de arquitectura PDF/PNG | [PNG](pitch/assets/tango-technology-architecture.png) y [PDF](pitch/assets/tango-technology-architecture.pdf) | Listo; ambos renderizados y revisados. |
| Diagrama de arquitectura resumido | [JPEG](architecture-diag.jpeg) | Listo; muestra el camino Cliente → Twilio → OpenAI Realtime → Backend → Supabase. |
| Al menos tres trade-offs reales | [Decision log](decision-log.md) | Listo: fuente de verdad durable, runtime de voz, SIP vs. Media Streams, validación del servidor y destinatario de escalación. |
| Casos feos explícitos | [Runbook: trial by fire](demo-runbook.md#trial-by-fire-register) | Listo: desconocido, fuera de mandato, interrupción, no-answer y escalación fallida. |
| Cambio en vivo por un juez | [Guion de ensayo](pitch/rehearsal-guide.md#live-proof-exact-sequence) | Pendiente de ensayo con un número de proveedor registrado. |
| Slides sin login | [PDF local](pitch/tango-pitch.pdf) y [PPTX editable](pitch/tango-pitch.pptx) | Material listo en repo. Decidir más adelante dónde compartirlo si realmente hace falta un enlace externo. |
| Pitch bajo tiempo | [Guion de 6:50](pitch/rehearsal-guide.md) | Pendiente: tres pasadas cronometradas (6:15, 6:35 y 6:50). |

## Ensayo final

1. Ejecutar `npm run demo:prepare`.
2. Abrir la operación `OP-900001` en el dashboard y verificar un destinatario
   de escalación activo en Directory.
3. Llamar desde un proveedor registrado y pedir un cambio dentro de la ventana.
4. Pedir inmediatamente un precio o una ventana fuera del mandato. La prueba
   pasa si aparece la escalación y no se crea un booking inválido.
5. Cronometrar la narración completa. Si falla una dependencia externa, mostrar
   el registro ya preparado y decir que es el fallback, sin pretender que fue
   una llamada en vivo.

## Nota de publicación

Por ahora no se publica ni se pushea nada más. Si en otro momento se decide
hacer público el repositorio o compartir un deck, primero revisar ese cambio
con el owner de GitHub y confirmar que es deseado.
