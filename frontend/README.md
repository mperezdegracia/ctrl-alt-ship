# Frontend

Next.js dashboard for a single operation. The first feature will be
`operation`: current status, mandate, quotes, commitment timeline,
escalations, and replay from checkpoints. All UI copy is in English.

It deploys independently as a Render Web Service. It authenticates with
Supabase directly and calls the Render backend with the user's access token.

## Render deployment

Create a Render Blueprint using `frontend/render.yaml`. It creates a separate
Next.js Web Service with automatic deploys from `main`; it does not modify the
voice backend service.

Configure these environment variables in Render:

```env
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_<key>
NEXT_PUBLIC_API_URL=https://ctrl-alt-ship.onrender.com
```

The `NEXT_PUBLIC_*` values are browser-visible by design. Do not add a
Supabase secret key, OpenAI key, or any backend secret to this service.

After the first deploy, use its `onrender.com` URL as the Supabase Auth Site
URL and add `<frontend-url>/**` to Supabase Auth Redirect URLs. Add the same
origin, without `/**`, to `DASHBOARD_ORIGINS` on the backend Render service.
