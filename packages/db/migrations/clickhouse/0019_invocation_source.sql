-- 0019_invocation_source.sql (#73)
-- Who called the tool: 'model', or 'widget' for the app's own iframe calling a
-- widget-invoked tool without `context`. Set by the SDK's intent layer, which
-- is the one place that can tell (SDK >= 0.4.0 with intent capture on, on
-- tools that do not own their `context`). NULL everywhere else — older SDKs,
-- intent off, tools with their own `context` — and NULL counts as a model
-- call: the intent coverage KPI excludes only rows that say 'widget', so
-- history keeps the denominator it had.
--
-- Widget calls carry no conversation to describe (a 3 s auto-refresh alone is
-- hundreds of calls a day), so without this column they depress the coverage
-- share and read like a capture regression.

ALTER TABLE events ADD COLUMN IF NOT EXISTS invocation_source LowCardinality(Nullable(String));
