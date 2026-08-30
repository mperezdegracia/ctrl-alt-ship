BEGIN;

-- The staging relation is deliberately inaccessible to service_role. Its RPC
-- validates the provider/call/segment tuple itself, so it must run with the
-- function owner's table privileges rather than the caller's table privileges.
ALTER FUNCTION public.stage_provider_quote_evidence(uuid, text, uuid, text, uuid)
  SECURITY DEFINER;
ALTER FUNCTION public.stage_provider_quote_evidence(uuid, text, uuid, text, uuid)
  SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.stage_provider_quote_evidence(uuid, text, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stage_provider_quote_evidence(uuid, text, uuid, text, uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
