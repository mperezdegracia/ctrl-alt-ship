BEGIN;

-- Booking selection is a backend RPC. The flow-isolation migration revoked
-- public execution but omitted the service_role grant, blocking both inbound
-- cancellation and rescheduling before their booking could be selected.
GRANT EXECUTE ON FUNCTION public.select_provider_booking(uuid,text,uuid,text,text,jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
