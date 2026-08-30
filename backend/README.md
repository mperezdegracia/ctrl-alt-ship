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

Booking confirmations are consumed by the in-process SMS outbox worker. Its
default `preview` mode never contacts a recipient; production uses Twilio when
`SMS_DELIVERY_MODE=twilio`, the existing Twilio credentials, and an SMS-capable
`TWILIO_FROM_NUMBER` are configured. Every provider SMS contains the booking
details needed for dispatch because providers do not use the dashboard. Run
`npm run harness:sms` to verify rendering and delivery failure handling without
Supabase or provider credentials.
