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
