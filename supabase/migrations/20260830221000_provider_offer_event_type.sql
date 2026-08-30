-- DB-101 M0. Keep this migration isolated: the enum value is consumed by M1+.
ALTER TYPE public.domain_event_type ADD VALUE IF NOT EXISTS 'quote.offered';
