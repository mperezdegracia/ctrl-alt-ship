-- PostgreSQL enum labels cannot safely be consumed until this migration commits.
ALTER TYPE public.domain_event_type ADD VALUE IF NOT EXISTS 'sms.queued';
ALTER TYPE public.domain_event_type ADD VALUE IF NOT EXISTS 'sms.sent';
ALTER TYPE public.domain_event_type ADD VALUE IF NOT EXISTS 'sms.failed';
