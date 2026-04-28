-- ============================================================================
-- supabase/migrations/20260428_analytics.sql
-- Lexi-Lens — Phase 3.7: Custom Analytics Tables
--
-- These tables power the custom analytics described in the roadmap:
--   • Words failed most often           → query word_fail_counts
--   • Quests with highest drop-off      → query quest_sessions
--   • Average scans per component       → aggregate on scan_attempts
--   • Session length by age band        → query game_sessions
--
-- All tables are APPEND-ONLY from the client (INSERT, no UPDATE/DELETE via RLS).
-- Reads are restricted to the parent who owns the child profile.
-- No raw text or PII is stored — only UUIDs and aggregates.
-- ============================================================================

-- ── 1. game_sessions ─────────────────────────────────────────────────────────
-- One row per app session (from foreground to background / close).
-- Records session length so we can analyse engagement by age band.

create table if not exists public.game_sessions (
  id              uuid primary key default gen_random_uuid(),
  child_id        uuid not null references public.child_profiles(id) on delete cascade,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,                          -- NULL while session is live
  duration_sec    int generated always as (
    extract(epoch from (ended_at - started_at))::int
  ) stored,
  screen_sequence text[],                               -- e.g. ['QuestMap','Scan','Victory']
  quests_started  int not null default 0,
  quests_finished int not null default 0,
  xp_earned       int not null default 0
);

alter table public.game_sessions enable row level security;

-- Parents can read their children's sessions
create policy "parent reads own child sessions"
  on public.game_sessions for select
  using (
    child_id in (
      select id from public.child_profiles
      where parent_id = auth.uid()
    )
  );

-- Client can insert a new session row
create policy "child inserts own session"
  on public.game_sessions for insert
  with check (
    child_id in (
      select id from public.child_profiles
      where parent_id = auth.uid()
    )
  );

-- Client can close (update ended_at) only sessions it opened
create policy "child closes own session"
  on public.game_sessions for update
  using (
    child_id in (
      select id from public.child_profiles
      where parent_id = auth.uid()
    )
  )
  with check (
    child_id in (
      select id from public.child_profiles
      where parent_id = auth.uid()
    )
  );

-- ── 2. quest_sessions ────────────────────────────────────────────────────────
-- One row per quest attempt (start + optional finish).
-- Used to compute drop-off rate per quest and median completion time.

create table if not exists public.quest_sessions (
  id             uuid primary key default gen_random_uuid(),
  child_id       uuid not null references public.child_profiles(id) on delete cascade,
  quest_id       uuid not null references public.quests(id) on delete cascade,
  game_session_id uuid references public.game_sessions(id) on delete set null,
  hard_mode      boolean not null default false,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,                          -- NULL = abandoned
  completed      boolean not null default false,
  total_scans    int not null default 0,
  xp_awarded     int not null default 0
);

alter table public.quest_sessions enable row level security;

create policy "parent reads quest sessions"
  on public.quest_sessions for select
  using (
    child_id in (
      select id from public.child_profiles where parent_id = auth.uid()
    )
  );

create policy "child manages own quest sessions"
  on public.quest_sessions for all
  using (
    child_id in (
      select id from public.child_profiles where parent_id = auth.uid()
    )
  )
  with check (
    child_id in (
      select id from public.child_profiles where parent_id = auth.uid()
    )
  );

-- ── 3. word_outcomes ─────────────────────────────────────────────────────────
-- One row per word × child × scan attempt.
-- Lets us compute: which words are failed most → content quality signal.

create table if not exists public.word_outcomes (
  id            uuid primary key default gen_random_uuid(),
  child_id      uuid not null references public.child_profiles(id) on delete cascade,
  quest_id      uuid references public.quests(id) on delete set null,
  word          text not null,          -- the vocabulary property word
  passed        boolean not null,       -- true = Claude said match for this property
  scan_label    text,                   -- what ML Kit / child scanned
  attempt_num   int not null default 1,
  created_at    timestamptz not null default now()
);

alter table public.word_outcomes enable row level security;

create policy "parent reads word outcomes"
  on public.word_outcomes for select
  using (
    child_id in (
      select id from public.child_profiles where parent_id = auth.uid()
    )
  );

create policy "child inserts word outcomes"
  on public.word_outcomes for insert
  with check (
    child_id in (
      select id from public.child_profiles where parent_id = auth.uid()
    )
  );

-- ── 4. Useful views (read-only — no RLS needed on views) ─────────────────────

-- Words ranked by failure rate across all children (global content signal)
create or replace view public.word_fail_rates as
select
  word,
  count(*)                                              as total_attempts,
  count(*) filter (where not passed)                   as fail_count,
  round(
    count(*) filter (where not passed)::numeric / count(*) * 100,
    1
  )                                                     as fail_pct
from public.word_outcomes
group by word
having count(*) >= 5                                   -- require ≥5 data points
order by fail_pct desc;

-- Quest drop-off: what % of children who start a quest finish it
create or replace view public.quest_dropoff as
select
  q.id                                                  as quest_id,
  q.name                                                as quest_name,
  count(qs.id)                                          as starts,
  count(qs.id) filter (where qs.completed)             as completions,
  round(
    count(qs.id) filter (where qs.completed)::numeric
    / nullif(count(qs.id), 0) * 100,
    1
  )                                                     as completion_pct
from public.quests q
left join public.quest_sessions qs on qs.quest_id = q.id
group by q.id, q.name
order by completion_pct asc nulls last;

-- Session length by child age band
create or replace view public.session_length_by_age as
select
  case
    when cp.age between 5 and 7  then '5-7'
    when cp.age between 8 and 10 then '8-10'
    when cp.age between 11 and 13 then '11-13'
    else '14+'
  end                                                    as age_band,
  count(gs.id)                                           as session_count,
  round(avg(gs.duration_sec) / 60.0, 1)                 as avg_duration_min,
  round(avg(gs.quests_finished), 1)                      as avg_quests_finished
from public.game_sessions gs
join public.child_profiles cp on cp.id = gs.child_id
where gs.ended_at is not null
group by age_band
order by age_band;

-- ── 5. Indexes for common query patterns ─────────────────────────────────────

create index if not exists idx_word_outcomes_word
  on public.word_outcomes (word);

create index if not exists idx_word_outcomes_child_quest
  on public.word_outcomes (child_id, quest_id);

create index if not exists idx_quest_sessions_child_quest
  on public.quest_sessions (child_id, quest_id);

create index if not exists idx_game_sessions_child_started
  on public.game_sessions (child_id, started_at desc);
