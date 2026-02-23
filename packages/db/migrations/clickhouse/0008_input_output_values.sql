-- 0008_input_output_values.sql
-- Add columns for full input/output capture on tool_call events.
-- input_values stores the PII-stripped input arguments as JSON.
-- output_content stores the PII-stripped serialized output as JSON.

ALTER TABLE events ADD COLUMN IF NOT EXISTS input_values String DEFAULT '{}';
ALTER TABLE events ADD COLUMN IF NOT EXISTS output_content String DEFAULT '{}';
