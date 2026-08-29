# Arquitectura inicial

## Decisión

El repositorio se organiza como un monorepo liviano con dos aplicaciones en la
raíz:

```text
.
├── backend/                 # Runtime Node/TypeScript en Render
│   ├── render.yaml           # Blueprint del runtime de Render
│   └── src/
│       ├── config/          # Variables de entorno y composición de dependencias
│       ├── http/            # Express: rutas, webhooks y middleware
│       ├── tango/           # Fachada operativa: IA, llamadas y servicios externos
│       │   ├── agents/      # Personas customer y provider
│       │   ├── prompts/     # Instrucciones versionadas
│       │   ├── realtime/    # Aceptación de llamada y sideband OpenAI
│       │   ├── tools/       # Adaptador de tools entre Realtime y aplicación
│       │   └── policies/    # Guardrails conversacionales y negociación
│       │   ├── telephony/   # Twilio, SIP/Media Streams, routing y escalación
│       │   ├── supabase/    # Cliente, repositorios y persistencia
│       │   ├── services/    # Email y otros proveedores externos
│       │   └── workers/     # Consumo del outbox, fan-out y reintentos
│       ├── domain/          # Operaciones, mandato, cotizaciones, bookings y eventos
│       └── shared/          # Tipos, errores y utilidades sin lógica de negocio
├── frontend/                # Código fuente del dashboard de operaciones
│   ├── public/
│   └── src/
│       ├── app/             # Arranque, rutas y layout
│       ├── features/        # Vistas por caso de uso (primero: operation)
│       ├── components/      # Componentes reutilizables de UI
│       └── lib/             # Cliente API y formateadores
├── contracts/               # Midfield congelado: schema, tools y eventos
└── scripts/harnesses/       # Harnesses ejecutables independientes por frente
```

`frontend/` no es un segundo runtime de voz: produce el dashboard estático que
el servicio de `backend/` sirve en Render. Así el despliegue sigue siendo un
solo contenedor, como fijan ADR 0002 e issue #2, y la UI no queda en el camino
de Twilio/OpenAI Realtime.

## Límites importantes

- **`domain/` es la autoridad de negocio.** Valida mandato, transiciones e
  idempotencia, sin conocer Supabase, Twilio ni OpenAI.
- **`tango/` es la fachada operativa del producto.** Encapsula IA, Supabase,
  telefonía, email, otros servicios externos y el worker. Sus tools llevan una
  acción de Realtime al dominio; el modelo nunca es la autoridad y nunca recibe
  el tope del mandato del proveedor.
- **`tango/telephony/` contiene el transporte de llamadas.** Puede elegir SIP
  o Media Streams sin filtrar detalles de Twilio al dominio.
- **`tango/workers/` consume el outbox fuera del request HTTP.** No bloquea la
  llamada del cliente mientras contacta proveedores.
- **`contracts/` queda en la raíz y se cambia coordinadamente.** No se copia
  dentro de Tango ni del backend.

## Express

Express no exige una estructura única: su generador presenta `routes/` como
una opción y aclara que se puede adaptar a cada aplicación. Acá `http/routes/`
mantiene esa convención para el borde HTTP, pero evitamos mezclar allí el
dominio, los prompts y los workers. `src/app.ts` debe construir la aplicación
Express sin hacer `listen`; `src/server.ts` será el único punto que abre el
puerto. Esto facilita harnesses y el worker en el mismo contenedor.

## Estado de la transición

El actual `script.ts` es el spike inbound probado y se conserva intacto. El
siguiente slice de scaffold debe mover su comportamiento gradualmente a
`backend/src/tango/telephony/` y `backend/src/tango/realtime/`, añadir los
entry points de TypeScript y actualizar los scripts npm. No se mueve ahora para
no romper la ruta de voz ya validada antes de contar con su reemplazo.
