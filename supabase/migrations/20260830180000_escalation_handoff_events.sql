-- Keep the enum change in its own committed migration. PostgreSQL does not let
-- a newly added enum value participate in DML before that transaction commits.
ALTER TYPE public.domain_event_type ADD VALUE IF NOT EXISTS 'escalation.handoff_requested';
ALTER TYPE public.domain_event_type ADD VALUE IF NOT EXISTS 'escalation.handoff_failed';
