# ctrl-alt-ship

Voice-driven freight coordination with a durable operation as the source of
truth.

The initial structure and boundaries between the backend, dashboard, and Tango
are documented in [`docs/architecture.md`](docs/architecture.md).

## Shared Supabase development

The team uses one hosted Supabase project for the hackathon. The backend owns
the server-only configuration. Create its local environment file and obtain its
secret values through the team's private secret sharing channel:

```bash
cp backend/.env.example backend/.env
npm --prefix backend run db:smoke
```

The smoke harness checks that the versioned domain tables are reachable with
the server-only Supabase key. Never commit `backend/.env` or expose
`SUPABASE_SECRET_KEY` in a browser.

Schema changes are new files in `supabase/migrations/`. The GitHub integration
deploys them from `main`; do not make shared-schema changes through the
Supabase Table Editor or SQL Editor.

## Demo data

Configure four distinct E.164 caller IDs in `backend/.env`, then seed Lucas
as the authorized client contact and three regular transportistas:

```bash
npm --prefix backend run db:seed -- --dry-run
npm --prefix backend run db:seed
```

The third provider is marked as non-responsive for the quote-timeout demo.
The seed is idempotent for the same caller IDs and refuses to overwrite an
existing identity. Caller IDs are validated globally before any write, and a
database trigger also prevents a phone from belonging to both a contact and a
provider. Use only consented test numbers; replace one provider number with the
judge's number immediately before the trial-by-fire run. Alternatively, set
`SEED_JUDGE_PHONE` to add the judge as a separate temporary provider.

The seed also upserts the stable operation fixture `OP-900001` for Textiles del
Plata: a 40-foot dry container, 24 t gross, Terminal 4 to Gonzalez Catan and a
fixed empty return in Dock Sud. It creates a demo mandate with an ARS 950,000
cap, one quote request per provider, Theo's valid ARS 850,000–900,000 quote,
Mateo's ARS 970,000–1,020,000 counteroffer scenario, and Paki's pending request.
Stable seed keys reuse the previous provider fixtures instead of duplicating
them when their demo names or phone numbers change.

Server and worker code can use
`backend/src/tango/supabase/erp.ts` to resolve an inbound caller across both
ERP identity tables or list active providers. The lookup intentionally returns
authorization/activity flags so inbound routing can reject callers explicitly.

## Inbound routing harness

Run the caller-ID routing contract without making real calls or writing to
Supabase:

```bash
npm --prefix backend run inbound:routing
```

It covers an authorized client, a known provider with an active operation and
an unknown caller. Production routing rejects unknown or invalid callers with
SIP 603 before accepting a Realtime session.

## Demo authentication

Supabase Auth owns user accounts and sessions in its internal `auth` schema;
the domain schema has no `users` table. For a temporary team test account,
use the publishable key and keep the password out of `backend/.env`:

```zsh
read -r "AUTH_SMOKE_EMAIL?Test email: "
read -s "AUTH_SMOKE_PASSWORD?Test password: "
echo
export AUTH_SMOKE_EMAIL AUTH_SMOKE_PASSWORD
npm --prefix backend run auth:smoke
unset AUTH_SMOKE_EMAIL AUTH_SMOKE_PASSWORD
```

With email confirmation disabled, the harness creates the account on the first
run and then verifies an email/password login. After all demo accounts exist,
disable new signups in Supabase Auth. The dashboard will use the publishable
key; server-only routes verify its Bearer JWT before accessing domain data.

## Render

`backend/render.yaml` defines the voice/API Node web service and
`frontend/render.yaml` defines a separate Next.js dashboard web service. In
the Render Dashboard, create one Blueprint from each file and enter the values
marked as secrets. Both services auto-deploy from `main`, independently.

The backend uses the Free plan for development and health-checks `/health`
against Supabase. The frontend health-checks `/login`. Use a paid always-on
backend instance before a voice demo.

## Realtime SIP test

The voice spike is deployed at `https://ctrl-alt-ship.onrender.com` and its
incoming OpenAI endpoint is `/openai/webhook`. It now accepts only signed
OpenAI webhooks:

1. In OpenAI Project Settings > Webhooks, create an endpoint for
   `https://ctrl-alt-ship.onrender.com/openai/webhook` and select
   `realtime.call.incoming`.
2. Copy its webhook secret to `OPENAI_WEBHOOK_SECRET` in Render and, for local
   work, in `backend/.env`. Do not commit or share that secret in chat.
3. Point the Twilio Elastic SIP Trunk origination URI at
   `sip:<OPENAI_PROJECT_ID>@sip.api.openai.com;transport=tls`, then assign the
   demo phone number to that trunk.
4. Call the demo number and inspect Render logs for a verified webhook, a
   successful call acceptance, and a connected Realtime sideband.

The OpenAI API key must remain only in `backend/.env` locally and in Render.
The browser never receives it.

## Running locally

Supabase remains hosted and shared; neither app starts a local database or Auth
stack.

```bash
cd frontend
cp .env.local.example .env.local
npm install
npm run dev
```

The frontend runs at `http://localhost:3000` and uses the hosted Supabase
project and Render API. `frontend/.env.local` contains only browser-safe
values. Before the browser calls the API directly, include
`http://localhost:3000` and the frontend's Render URL in the backend
service's `DASHBOARD_ORIGINS` environment variable.

To run the backend locally as well, start it in another terminal. It defaults
to port 3000, so run the frontend on a different port in that case:

At startup, the backend validates its runtime configuration with Zod before it
opens its HTTP port. `SUPABASE_URL`, `SUPABASE_SECRET_KEY`,
`SUPABASE_PUBLISHABLE_KEY`, `OPENAI_API_KEY`, and `OPENAI_WEBHOOK_SECRET` are
required; `PORT`, `NODE_ENV`, `LOG_LEVEL`, and `DASHBOARD_ORIGINS` have safe
defaults documented in `backend/.env.example`. A missing or malformed value
stops the process with a list of configuration errors, rather than failing in
the middle of a call.

```bash
npm --prefix backend run dev
npm --prefix frontend run dev -- --port 3001
```

`frontend/.env.local` contains only browser-safe Supabase settings and the

## Verification commands

The following local commands are focused checks, not separate production
workers:

```bash
npm --prefix backend run db:smoke        # Supabase connectivity and server key
npm --prefix backend run inbound:routing # caller-ID routing, without calls
npm --prefix backend run auth:smoke      # Supabase Auth login flow
npm --prefix backend run db:seed         # demo fixture data
```

`db:smoke` is retained because the team shares a hosted Supabase project: it
quickly confirms that the configured server credentials can reach the versioned
domain tables before testing a call in Render.
