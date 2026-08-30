-- The sourcing trigger uses this event while confirming a mandate. Without
-- the enum value, PostgreSQL rolls back the entire mandate transaction.
-- Keep this migration separate: the new enum value must commit before use.
ALTER TYPE public.domain_event_type ADD VALUE IF NOT EXISTS 'sourcing.dispatch_queued';

NOTIFY pgrst, 'reload schema';
