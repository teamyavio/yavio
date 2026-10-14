-- Erasure covers every table that holds a tenant's data (#91 part 2).
--
-- yavio_eraser could delete from events only (0012), so a deleted workspace
-- or project left its rows in tool_registry, in the per-user/session
-- summaries and in the anonymous statistics (#85). The tier-2 tables hold no
-- identifiers, but a deleted customer's statistics are still the customer's
-- data and go with it.
--
-- ALTER DELETE only, as before: the eraser still cannot read what it erases.
-- On a materialized view, ALTER DELETE reaches its inner table (checked on
-- 24.3 and 26.8); DELETE FROM <mv> is not supported. users_mv / sessions_mv
-- go away with #89; the worker treats a table that no longer exists as done.

GRANT ALTER DELETE ON default.tool_registry TO yavio_eraser;
GRANT ALTER DELETE ON default.stats_daily TO yavio_eraser;
GRANT ALTER DELETE ON default.stats_users_daily TO yavio_eraser;
GRANT ALTER DELETE ON default.stats_users_periods TO yavio_eraser;
GRANT ALTER DELETE ON default.stats_cohorts TO yavio_eraser;
GRANT ALTER DELETE ON default.users_mv TO yavio_eraser;
GRANT ALTER DELETE ON default.sessions_mv TO yavio_eraser;
