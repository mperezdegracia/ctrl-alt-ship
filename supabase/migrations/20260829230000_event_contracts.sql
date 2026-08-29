CREATE TYPE domain_event_type AS ENUM (
  'call.rejected', 'call.routed', 'call.completed', 'call.failed', 'call.transferred',
  'operation.created', 'operation.updated', 'operation.cancelled',
  'mandate.confirmed', 'sourcing.started',
  'quote.requested', 'quote.received', 'quote.counteroffer_requested',
  'quote.declined', 'quote.expired', 'quote.selected',
  'booking.pending', 'booking.confirmed', 'booking.declined',
  'booking.rescheduled', 'booking.reschedule_declined', 'booking.cancelled',
  'escalation.started', 'escalation.supervisor_joined',
  'escalation.resolved', 'escalation.failed',
  'email.queued', 'email.sent', 'email.failed'
);

ALTER TABLE events DROP CONSTRAINT events_type_check;

ALTER TABLE events
  ALTER COLUMN operation_id DROP NOT NULL,
  ALTER COLUMN type TYPE domain_event_type USING type::domain_event_type,
  ADD COLUMN schema_version smallint NOT NULL DEFAULT 1;

ALTER TABLE events
  ADD CONSTRAINT events_schema_version_check CHECK (schema_version > 0),
  ADD CONSTRAINT events_operation_scope_check CHECK (
    operation_id IS NOT NULL
    OR (type = 'call.rejected' AND call_id IS NULL AND commitment_id IS NULL)
  ),
  ADD CONSTRAINT events_checkpoint_call_check
    CHECK (recording_checkpoint IS NULL OR call_id IS NOT NULL);
