# Backend

Node.js/TypeScript runtime using Express. Its `src/` tree follows the
boundaries defined in [`docs/architecture.md`](../docs/architecture.md):
Express is the HTTP edge, `domain/` holds the business rules, and `tango/` is
the operational facade for Supabase, telephony, AI, external services and
workers.

This application deploys to Render. The dashboard in `../frontend/` is a
separate Next.js application that deploys to Vercel and calls this API with a
Supabase access token.
