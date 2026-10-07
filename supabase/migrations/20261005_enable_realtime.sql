-- Enable Supabase Realtime for the calendar tables.
--
-- WHY THIS IS NEEDED: Realtime only broadcasts changes for tables that are
-- members of the `supabase_realtime` publication. New projects add tables to it
-- by default, but a table created with plain SQL is NOT added automatically —
-- which is exactly this project's case, so the socket connects ("SUBSCRIBED")
-- but no INSERT/UPDATE/DELETE is ever delivered, and the phone never sees the
-- laptop's new task.
--
-- Also needed: REPLICA IDENTITY FULL so DELETE payloads carry the old row
-- (without it `payload.old` only contains the primary key). On these tables the
-- primary key IS the id, which is all the client needs — but FULL also makes
-- filtered deletes behave predictably, so it is set explicitly.
--
-- Run this in Supabase Dashboard → SQL Editor. It is idempotent.

do $$
declare
  t text;
begin
  foreach t in array array['tasks', 'spheres', 'journal_entries', 'user_settings'] loop
    -- add to the realtime publication if not already a member
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
    -- ship the whole old row on DELETE
    execute format('alter table public.%I replica identity full', t);
  end loop;
end $$;

-- Verify (should list all four tables):
--   select tablename from pg_publication_tables
--   where pubname = 'supabase_realtime' order by tablename;
