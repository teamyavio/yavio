-- 0019_intent_context.sql (#73)
-- How the SDK advertised the intent `context` parameter for the called tool:
--   'required'  the model is asked to state an intent on every call;
--   'optional'  widget-invoked tools (the app's own iframe calls them and
--               cannot send it) or intent `required: false`;
--   'none'      nothing advertised: intent capture off, per-tool `intent: false`,
--               a tool with its own `context` or a schema the SDK cannot
--               extend (oneOf/anyOf/allOf, passthrough), an unknown tool.
-- NULL: an SDK before 0.4.0.
--
-- It is the server's advertisement at call time. A host that still shows the
-- model a cached schema can differ until it refreshes.
--
-- Why not "who called" (model vs widget): on a widget-invoked tool a model
-- call that skips the optional parameter looks exactly like the widget's own
-- call, and models skip it often. The advertisement is a fact; the caller
-- would be a guess. The dashboard's Call Coverage counts 'required' calls and
-- NULL rows (history keeps its denominator) and shows 'optional' separately.

ALTER TABLE events ADD COLUMN IF NOT EXISTS intent_context LowCardinality(Nullable(String));
