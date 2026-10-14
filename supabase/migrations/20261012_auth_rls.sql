-- RLS Policies and authentication enforcement migration
-- Run this in Supabase Dashboard -> SQL editor.

-- 1. Enable RLS on all core tables
alter table public.spheres enable row level security;
alter table public.tasks enable row level security;
alter table public.journal_entries enable row level security;
alter table public.user_settings enable row level security;

-- 2. Drop any existing policies to avoid conflicts
drop policy if exists "Users can manage their own spheres" on public.spheres;
drop policy if exists "Users can manage their own tasks" on public.tasks;
drop policy if exists "Users can manage their own journal entries" on public.journal_entries;
drop policy if exists "Users can manage their own settings" on public.user_settings;

-- 3. Create RLS policies enforcing user_id = auth.uid()
create policy "Users can manage their own spheres"
  on public.spheres
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can manage their own tasks"
  on public.tasks
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can manage their own journal entries"
  on public.journal_entries
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can manage their own settings"
  on public.user_settings
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
