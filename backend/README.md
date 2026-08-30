# Backend

Node.js/TypeScript runtime using Express. Its `src/` tree follows the
boundaries defined in [`docs/architecture.md`](../docs/architecture.md):
Express is the HTTP edge, `domain/` holds the business rules, and `tango/` is
the operational facade for Supabase, telephony, AI, external services and
workers.

This application deploys to Render. The dashboard in `../frontend/` is a
separate Next.js application that deploys to Vercel and calls this API with a
Supabase access token.

Run it locally from this directory with `npm ci` and `npm run dev`.

Booking confirmation mail is consumed by the in-process outbox worker. Its
default `preview` mode persists rendered messages to the server-only
`email_previews` table without sending them; production uses Resend when
`EMAIL_DELIVERY_MODE=resend`, `RESEND_API_KEY`, and `EMAIL_FROM` are present.
Run `npm run harness:email` to verify rendering and delivery failure handling
without Supabase or provider credentials.
