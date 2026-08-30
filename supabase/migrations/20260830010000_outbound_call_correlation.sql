-- A Twilio outbound attempt exists before OpenAI creates its Realtime call.
-- Unique nullable columns still prevent duplicate external IDs once attached.
ALTER TABLE calls
  ALTER COLUMN twilio_call_sid DROP NOT NULL,
  ALTER COLUMN realtime_call_id DROP NOT NULL;
