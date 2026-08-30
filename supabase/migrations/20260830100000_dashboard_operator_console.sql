BEGIN;

-- Dashboard writes are deliberately separated from the immutable domain
-- evidence. Every human-initiated change gets its own append-only audit row.
CREATE TABLE public.operator_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN (
    'operation.corrected', 'escalation.resolved',
    'contact.created', 'contact.updated', 'contact.deactivated',
    'provider.created', 'provider.updated', 'provider.deactivated'
  )),
  operation_id uuid REFERENCES public.operations(id),
  escalation_id uuid REFERENCES public.escalations(id),
  contact_id uuid REFERENCES public.contacts(id),
  provider_id uuid REFERENCES public.providers(id),
  before_state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(before_state) = 'object'),
  after_state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(after_state) = 'object'),
  note text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (btrim(coalesce(note, '')) <> '' OR action <> 'escalation.resolved'),
  CHECK ((operation_id IS NOT NULL)::integer + (escalation_id IS NOT NULL)::integer
    + (contact_id IS NOT NULL)::integer + (provider_id IS NOT NULL)::integer >= 1)
);

CREATE INDEX operator_actions_operation_occurred_idx
  ON public.operator_actions(operation_id, occurred_at DESC);
CREATE INDEX operator_actions_escalation_occurred_idx
  ON public.operator_actions(escalation_id, occurred_at DESC);

CREATE TRIGGER operator_actions_append_only
BEFORE UPDATE OR DELETE ON public.operator_actions
FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE TABLE public.dashboard_saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('operations', 'escalations')),
  name text NOT NULL CHECK (btrim(name) <> ''),
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope, name)
);

CREATE TRIGGER dashboard_saved_views_touch_updated_at
BEFORE UPDATE ON public.dashboard_saved_views
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.operator_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_saved_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON public.operator_actions, public.dashboard_saved_views FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.operator_actions, public.dashboard_saved_views TO service_role;

COMMIT;
