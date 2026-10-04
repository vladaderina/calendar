-- Schema for the calendar app (tasks + spheres + journal).
-- Run this in Supabase Dashboard → SQL editor.
-- This script DROPS existing tables and recreates them with the correct schema.
-- (Tables are created empty — no data is lost.)

-- ── Disable RLS on existing tables before dropping ──────────────────────
alter table if exists public.spheres        disable row level security;
alter table if exists public.tasks          disable row level security;
alter table if exists public.journal_entries disable row level security;
alter table if exists public.user_settings   disable row level security;

-- ── Drop old tables (cascades to indexes and constraints) ─────────────────
drop table if exists public.tasks             cascade;
drop table if exists public.spheres           cascade;
drop table if exists public.journal_entries   cascade;
drop table if exists public.user_settings     cascade;

-- ── Recreate: spheres ─────────────────────────────────────────────────────
create table public.spheres (
  id         uuid    primary key default uuid_generate_v4(),
  user_id    uuid    not null,
  name       text    not null,
  "order"    integer not null default 0,
  created_at timestamp with time zone default now()
);
create unique index spheres_user_name_idx on public.spheres (user_id, name);

-- ── Recreate: tasks ───────────────────────────────────────────────────────
create table public.tasks (
  id               uuid          primary key default uuid_generate_v4(),
  user_id          uuid          not null,
  title            text          not null,
  notes            text,
  start_date       text,
  end_date         text,
  sphere           text,
  recurrence       text          not null default 'none',
  recurrence_days  integer[],
  year_dates       text[],
  reminder_days    integer,
  color            text,
  priority         text          not null default 'low',
  unplanned        boolean       not null default false,
  "order"          bigint,
  completed        boolean       not null default false,
  completed_at     timestamp with time zone,
  completed_dates  text[],
  excluded_dates   text[],
  recurrence_until text,
  subtask_ids      uuid[],
  subtask_of       uuid          references public.tasks on delete set null,
  created_at       timestamp with time zone default now()
);
create index tasks_user_idx on public.tasks (user_id);
create index tasks_date_start_idx on public.tasks (user_id, start_date);

-- ── Recreate: journal_entries ──────────────────────────────────────────────
create table public.journal_entries (
  id         uuid          primary key default uuid_generate_v4(),
  user_id    uuid          not null,
  date_key   text          not null,
  text       text          not null default '',
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);
create unique index journal_user_date_idx on public.journal_entries (user_id, date_key);

-- ── Recreate: user_settings ───────────────────────────────────────────────
create table public.user_settings (
  user_id   uuid primary key,
  last_view text default 'week',
  created_at timestamp with time zone default now()
);

-- ── Disable RLS on ALL tables (personal app — anon key is the only auth) ──
--    Supabase enables RLS by default for new tables. Since this is a personal
--    app and the anon key is the only auth mechanism, we disable RLS so the
--    app can freely read/write data.
--    (If you later want per-user isolation, create policies instead.)
alter table public.spheres          disable row level security;
alter table public.tasks            disable row level security;
alter table public.journal_entries  disable row level security;
alter table public.user_settings    disable row level security;
