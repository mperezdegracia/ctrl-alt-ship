import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Static merge-regression checks only. No PostgreSQL, calls or email delivery.
const root = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const files = readdirSync(resolve(root, "supabase/migrations")).filter((name) => name.endsWith(".sql"));
assert.equal(new Set(files.map((name) => name.split("_")[0])).size, files.length, "Migration versions must be unique");
const eventFix = read("supabase/migrations/20260830100000_sourcing_dispatch_event.sql");
assert.match(eventFix, /ALTER TYPE public.domain_event_type ADD VALUE IF NOT EXISTS 'sourcing.dispatch_queued'/);
assert.match(read("contracts/schema.sql"), /'mandate.confirmed', 'sourcing.started', 'sourcing.dispatch_queued'/);
const sql = read("supabase/migrations/20260830090000_integrate_provider_sourcing.sql");
const finalizer = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.finalize_operation_sourcing"));
assert.match(sql, /ORDER BY name, id LIMIT 2/);
assert.match(sql, /VALUES \(op.id, candidate.id, NEW.id, 1, 'queued', 'infinity'::timestamptz/);
assert.match(sql, /dispatched_at = coalesce\(dispatched_at, clock_timestamp\(\)\)/);
assert.match(finalizer, /WHERE id = p_operation_id FOR UPDATE/);
assert.match(finalizer, /op.status NOT IN \('sourcing', 'quotes_received'\) OR op.mandate_confirmation_required/);
assert.match(finalizer, /qr.mandate_id = m.id/);
assert.match(finalizer, /latest.verdict = 'contraoferta'/);
assert.match(finalizer, /IF still_open AND clock_timestamp\(\) < dispatched \+ interval '5 minutes'/);
assert.match(finalizer, /'finalized', false, 'reason', 'waiting_for_valid_quote'/);
assert.doesNotMatch(finalizer, /SET status = '(needs_follow_up|expired)'|interval '2 minutes'|INSERT INTO public.commitments/);
for (const rule of ["q.verdict = 'dentro'", "q.price_max <= m.price_cap", "q.currency = m.currency",
  "q.payment_term_days >= m.minimum_payment_term_days", "q.valid_until > clock_timestamp()",
  "q.evaluated_mandate_id = m.id", "qr.status = 'responded'", "p.active", "q.conditions->'notes'", "m.action_windows"]) {
  assert.ok(finalizer.includes(rule), `Missing winner eligibility: ${rule}`);
}
assert.match(finalizer, /ORDER BY CASE WHEN q.received_at > dispatched \+ interval '5 minutes' THEN q.received_at ELSE dispatched END ASC,\s+q.price_max ASC, q.received_at ASC, q.id ASC/);
assert.ok(finalizer.indexOf("SET status = 'quotes_received'") < finalizer.indexOf("SET status = 'quote_selected'"));
assert.match(finalizer, /INSERT INTO public.bookings/);
assert.match(finalizer, /'commitment_created', false/);
assert.match(sql, /REVOKE EXECUTE ON FUNCTION public.record_provider_quote.*FROM service_role/);
const email = read("supabase/migrations/20260830050001_booking_confirmation_email_outbox.sql");
for (const column of ["locked_until", "lock_token", "last_error_code", "provider_message_id"]) {
  assert.ok(email.includes(`ADD COLUMN IF NOT EXISTS ${column}`), "Renumbered email migration must tolerate existing columns");
}
assert.match(email, /CREATE TABLE IF NOT EXISTS public.email_previews/);
assert.match(email, /CREATE INDEX IF NOT EXISTS outbox_email_claim_idx/);
assert.doesNotMatch(email, /CREATE FUNCTION public\.|DROP TABLE|DELETE FROM|TRUNCATE/);
assert.match(email, /DROP TRIGGER IF EXISTS email_previews_append_only/);
assert.match(email, /DROP TRIGGER IF EXISTS bookings_enqueue_confirmation_emails/);
assert.match(email, /PERFORM public.queue_booking_confirmation_emails\(NEW.id\)/);
assert.ok(email.includes("'booking_confirmation_client'"));
assert.ok(email.includes("'booking_confirmation_provider'"));
const quotes = read("supabase/migrations/20260830070000_provider_quote_tools.sql");
assert.match(quotes, /negotiation_limit smallint NOT NULL DEFAULT 3/);
assert.match(quotes, /'record_provider_quote'/);
assert.match(read("supabase/migrations/20260830080000_provider_booking_changes.sql"), /'record_provider_quote'/);
assert.doesNotMatch(read("backend/src/tango/tools/call-tool-factory.ts"), /RecordProviderQuoteTool/);
assert.match(read("backend/src/server.ts"), /\.in\("status", \["sourcing", "quotes_received"\]\)/);
assert.doesNotMatch(read("backend/src/server.ts"), /new NegotiationStallTracker/);
console.log("Sourcing integration checks passed: unique migrations, dispatch clock, waiting policy, three rounds, eligibility, deterministic ranking, email trigger and no fabricated commitments. Static SQL checks, not PostgreSQL execution.");
