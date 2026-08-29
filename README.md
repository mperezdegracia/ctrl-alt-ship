# ctrl-alt-ship

Voice-driven freight coordination with a durable operation as the source of
truth.

The initial structure and boundaries between the backend, dashboard, and Tango
are documented in [`docs/architecture.md`](docs/architecture.md).

## Shared Supabase development

The team uses one hosted Supabase project for the hackathon. Create a local
environment file and obtain its secret values through the team's private secret
sharing channel:

```bash
cp .env.example .env
npm run db:smoke
```

The smoke harness checks that the versioned domain tables are reachable with
the server-only Supabase key. Never commit `.env` or expose
`SUPABASE_SECRET_KEY` in a browser.

Schema changes are new files in `supabase/migrations/`. The GitHub integration
deploys them from `main`; do not make shared-schema changes through the
Supabase Table Editor or SQL Editor.

## Demo authentication

Supabase Auth owns user accounts and sessions in its internal `auth` schema;
the domain schema has no `users` table. For a temporary team test account,
use the publishable key and keep the password out of `.env`:

```zsh
read -r "AUTH_SMOKE_EMAIL?Test email: "
read -s "AUTH_SMOKE_PASSWORD?Test password: "
echo
export AUTH_SMOKE_EMAIL AUTH_SMOKE_PASSWORD
npm run auth:smoke
unset AUTH_SMOKE_EMAIL AUTH_SMOKE_PASSWORD
```

With email confirmation disabled, the harness creates the account on the first
run and then verifies an email/password login. After all demo accounts exist,
disable new signups in Supabase Auth. The dashboard will use the publishable
key; server-only routes verify its Bearer JWT before accessing domain data.

## Render

`backend/render.yaml` defines the single Node web service. In the Render
Dashboard, create a Blueprint from this file and enter the values marked as
secrets.
The initial service uses the Free plan for development and health-checks
`/health` against Supabase. Use a paid always-on instance before a voice demo.
