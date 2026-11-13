-- Fails (non-empty result) if any public table has RLS disabled.
-- Run as the last step of every future build phase that adds tables.
-- See docs/specs/rls-lockdown-scr-tables.md for the incident this guards against.
select c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
