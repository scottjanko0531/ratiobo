# Repo conventions

## Row Level Security

Every new `public` table must `enable row level security` and get a `<table>_read` policy (`FOR SELECT TO authenticated USING (true)` for shared/computed data, or `USING (user_id = auth.uid())` for user-owned data) in the **same migration** that creates the table. Never leave anon grants on a computed or reference table — writes go through `service_role` or a direct Postgres connection, both of which bypass RLS, so tables almost never need insert/update/delete policies.

Run `scripts/check-rls.sql` after any migration that adds a table; it fails (non-empty result) if any `public` table has RLS disabled. See `docs/specs/rls-lockdown-scr-tables.md` for the incident this guards against.
