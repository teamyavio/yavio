-- 0009_client_metadata.sql
-- First-class columns for client metadata that platforms already transmit in
-- request _meta (ChatGPT: openai/locale, openai/userAgent, openai/subject,
-- openai/userLocation.country). Until now these were only recoverable by
-- parsing input_values JSON — and only on events from apps that capture
-- arguments. country_code (0002) is populated from the same source.
--
-- locale:          BCP-47 tag of the end user's UI language (e.g. "de-DE").
-- end_user_agent:  the end user's device/browser UA as transmitted by the
--                  platform (NOT the connector's HTTP user-agent).
-- subject_id:      stable pseudonymous per-user-per-app id minted by the
--                  platform (ChatGPT's openai/subject). Not correlatable
--                  across apps; carries no personal data.

ALTER TABLE events ADD COLUMN IF NOT EXISTS locale LowCardinality(Nullable(String));
ALTER TABLE events ADD COLUMN IF NOT EXISTS end_user_agent Nullable(String);
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_id Nullable(String);
