# Backend

Node.js/TypeScript runtime using Express. Its `src/` tree follows the
boundaries defined in [`docs/architecture.md`](../docs/architecture.md):
Express is the HTTP edge, `domain/` holds the business rules, and `tango/` is
the operational facade for Supabase, telephony, AI, external services and
workers.

The dashboard built from `../frontend/` will be served statically by this
runtime; it does not run as a separate service during the demo.
