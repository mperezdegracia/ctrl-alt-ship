-- Durable escalations use the same immutable command-receipt ledger as every
-- other realtime mutation, so retries cannot create duplicate human reviews.
BEGIN;

ALTER TABLE public.tool_command_receipts
  DROP CONSTRAINT tool_command_receipts_tool_name_check,
  ADD CONSTRAINT tool_command_receipts_tool_name_check CHECK (tool_name IN (
    'create_operation', 'update_operation', 'confirm_mandate', 'cancel_operation',
    'create_quote', 'decline_quote_request', 'reschedule_booking', 'cancel_booking',
    'record_provider_quote', -- Historical receipts; the legacy RPC is revoked.
    'escalate'
  ));

NOTIFY pgrst, 'reload schema';

COMMIT;
