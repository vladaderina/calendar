-- Moodboard photos and dashboard notes.
--
-- One row per entry: adding a photo uploads only that photo, so the whole
-- moodboard is never rewritten in one request. `payload` holds
--   photo: { data: "data:image/…", caption, born }
--   note:  { text, color, born }
-- `t` is the last change (ms) — two devices merge last-write-wins per row;
-- a delete leaves the row in place with `deleted = true` and no picture bytes,
-- which is what stops an older copy on the other device from resurrecting it.
--
-- Applied to the self-hosted project (luna-db) on 2026-11-16. The grants and
-- the PostgREST schema-cache reload are part of the migration on purpose:
-- without them the table answers 404 to writes through /rest/v1.

create table if not exists public.board_items (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  t bigint not null default 0,
  deleted boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists board_items_user_idx on public.board_items (user_id);

alter table public.board_items enable row level security;

drop policy if exists "board_items: read own" on public.board_items;
drop policy if exists "board_items: insert own" on public.board_items;
drop policy if exists "board_items: update own" on public.board_items;
drop policy if exists "board_items: delete own" on public.board_items;

create policy "board_items: read own" on public.board_items
  for select to authenticated using (user_id = auth.uid());
create policy "board_items: insert own" on public.board_items
  for insert to authenticated with check (user_id = auth.uid());
create policy "board_items: update own" on public.board_items
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "board_items: delete own" on public.board_items
  for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on public.board_items to authenticated;
grant all on public.board_items to service_role;

-- Realtime would broadcast whole photos on every caption edit — the app polls
-- instead (on open, on focus, and after each local change).
notify pgrst, 'reload schema';
