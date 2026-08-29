# Runtime en Render; Vercel fuera del camino de voz

El runtime de voz necesita un proceso siempre activo: un servidor WebSocket
(si el fallback Media Streams hace falta), el canal sideband hacia OpenAI
Realtime y un worker que origina llamadas salientes. Vercel es cómputo
por-request (serverless/fluid) y no puede hostear nada de eso, así que queda
fuera del camino de voz aunque estaba sobre la mesa. Elegimos **Render** para
el servicio único (API + webhooks Twilio + sideband + worker + dashboard
estático) porque el equipo ya lo usó; el "warm-up lento" que habíamos visto es
el spin-down del tier free, no un defecto del producto.

## Considered Options

- **Railway / Fly.io / Cloud Run** — válidos, pero nadie del equipo los usó y
  una hackathon no es el momento de aprender un PaaS.
- **Vercel para todo** — rechazado: sin WebSocket server ni worker persistente.

## Consecuencias

- Empezamos en el tier free; si el spin-down molesta, pasamos a Starter (~7
  USD/mes).
- **El día del demo el free tier es riesgo inaceptable**: instancia paga o un
  keep-alive ping activo, decidido antes del trial by fire.
- Supabase Postgres para el estado; Cloudflare Tunnel solo para desarrollo
  local (queda como plan B ensayado el día del demo).
