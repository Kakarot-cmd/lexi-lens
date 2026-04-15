-- ============================================================
-- Lexi-Lens RPG — Supabase PostgreSQL Schema
-- ============================================================
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query)
-- or apply via: supabase db push
--
-- Architecture decisions:
--   • Parent accounts own child profiles (COPPA compliance).
--   • No PII stored for child profiles — only a display name + age band.
--   • Camera frames are NEVER persisted — only evaluation results.
--   • Row Level Security (RLS) ensures parents can only see their own children.
-- ============================================================

-- ─── Extensions ──────────────────────────────────────────────

create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm"; -- for word search in the Word Tome


-- ─── Parents ─────────────────────────────────────────────────
-- Linked to Supabase Auth (auth.users) via id.
-- Supabase creates auth.users on signup — we extend it here.

create table public.parents (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text    not null,
  created_at   timestamptz not null default now()
);

alter table public.parents enable row level security;

-- Parents can only read/update their own record
create policy "parents: own row only"
  on public.parents
  for all
  using  (auth.uid() = id)
  with check (auth.uid() = id);


-- ─── Child profiles ───────────────────────────────────────────
-- One parent can have multiple children.
-- No email, no last name — only what's needed for gameplay.

create table public.child_profiles (
  id          uuid        primary key default uuid_generate_v4(),
  parent_id   uuid        not null references public.parents(id) on delete cascade,
  display_name text       not null check (char_length(display_name) <= 30),
  -- Age band instead of exact DOB (less sensitive data)
  age_band    text        not null check (age_band in ('5-6', '7-8', '9-10', '11-12')),
  avatar_key  text,                    -- key into a fixed set of avatar images (no uploads)
  level       int         not null default 1 check (level between 1 and 100),
  total_xp    int         not null default 0 check (total_xp >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.child_profiles enable row level security;

create policy "child_profiles: parent owns children"
  on public.child_profiles
  for all
  using  (parent_id = auth.uid())
  with check (parent_id = auth.uid());

-- Auto-update updated_at
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger child_profiles_touch_updated_at
  before update on public.child_profiles
  for each row execute function public.touch_updated_at();


-- ─── Quests ───────────────────────────────────────────────────
-- Quests are global (not per-child). Think of this as the content library.
-- A Supabase admin (service role) manages these, not parents.

create table public.quests (
  id                  uuid primary key default uuid_generate_v4(),
  name                text not null,
  enemy_name          text not null,   -- "Boredom Behemoth"
  enemy_emoji         text not null,   -- "👾"
  room_label          text not null,   -- "Living Room"
  min_age_band        text not null check (min_age_band in ('5-6', '7-8', '9-10', '11-12')),
  xp_reward_first_try int  not null default 40,
  xp_reward_retry     int  not null default 20,
  -- Array of property requirement objects (validated by app layer)
  -- Schema: [{ word, definition, evaluationHints }]
  required_properties jsonb not null default '[]',
  is_active           bool not null default true,
  created_at          timestamptz not null default now()
);

-- Quests are readable by any authenticated user (parent checking available quests)
alter table public.quests enable row level security;
create policy "quests: authenticated read"
  on public.quests for select
  using (auth.role() = 'authenticated' and is_active = true);


-- ─── Scan attempts ────────────────────────────────────────────
-- Every time a child scans an object, we record what happened.
-- NO camera frames stored here — only the evaluation result.

create table public.scan_attempts (
  id                uuid        primary key default uuid_generate_v4(),
  child_id          uuid        not null references public.child_profiles(id) on delete cascade,
  quest_id          uuid        not null references public.quests(id),
  -- What Vision API detected on-device
  detected_label    text        not null,
  vision_confidence numeric(4,3) not null check (vision_confidence between 0 and 1),
  -- What Claude decided
  resolved_name     text        not null,   -- Claude's understanding of the object
  overall_match     bool        not null,
  property_scores   jsonb       not null,   -- [{ word, score, reasoning, passes }]
  child_feedback    text        not null,   -- Shown to the child in-app
  xp_awarded        int         not null default 0 check (xp_awarded >= 0),
  -- Latency tracking (ms) — useful for perf optimization
  vision_latency_ms int,
  claude_latency_ms int,
  created_at        timestamptz not null default now()
);

alter table public.scan_attempts enable row level security;

-- Parents can read their children's attempts; children's session can insert
create policy "scan_attempts: parent reads own children"
  on public.scan_attempts for select
  using (
    child_id in (
      select id from public.child_profiles where parent_id = auth.uid()
    )
  );

create policy "scan_attempts: service role inserts"
  on public.scan_attempts for insert
  with check (true); -- controlled by Edge Function using service_role key


-- ─── Word Tome ────────────────────────────────────────────────
-- The "Word Tome" is the child's personal vocabulary journal.
-- One row per (child, word) — updated each time they successfully
-- use that word as a material component.

create table public.word_tome (
  id              uuid        primary key default uuid_generate_v4(),
  child_id        uuid        not null references public.child_profiles(id) on delete cascade,
  word            text        not null,
  definition      text        not null,
  -- The real object the child used to demonstrate this word (e.g. "glass of water")
  exemplar_object text        not null,
  times_used      int         not null default 1 check (times_used >= 1),
  first_used_at   timestamptz not null default now(),
  last_used_at    timestamptz not null default now(),

  unique (child_id, word)
);

alter table public.word_tome enable row level security;

create policy "word_tome: parent reads own children"
  on public.word_tome for select
  using (
    child_id in (
      select id from public.child_profiles where parent_id = auth.uid()
    )
  );

create policy "word_tome: service role writes"
  on public.word_tome for all
  with check (true); -- controlled by Edge Function

-- Index for fast lookup + search in the Word Tome UI
create index word_tome_child_idx on public.word_tome (child_id);
create index word_tome_word_trgm  on public.word_tome using gin (word gin_trgm_ops);


-- ─── Quest completions ────────────────────────────────────────
-- Tracks which quests a child has finished (all components found).

create table public.quest_completions (
  id           uuid        primary key default uuid_generate_v4(),
  child_id     uuid        not null references public.child_profiles(id) on delete cascade,
  quest_id     uuid        not null references public.quests(id),
  total_xp     int         not null,
  attempt_count int        not null default 1,
  completed_at timestamptz not null default now(),

  unique (child_id, quest_id)  -- a child completes each quest only once
);

alter table public.quest_completions enable row level security;

create policy "quest_completions: parent reads own"
  on public.quest_completions for select
  using (
    child_id in (
      select id from public.child_profiles where parent_id = auth.uid()
    )
  );

create policy "quest_completions: service role writes"
  on public.quest_completions for all
  with check (true);


-- ─── Helper: award XP + level up ─────────────────────────────
-- Called by the Edge Function after a successful scan.
-- Encapsulates XP math server-side so clients can't spoof it.

create or replace function public.award_xp(
  p_child_id uuid,
  p_xp       int
)
returns table (new_xp int, new_level int, leveled_up bool)
language plpgsql security definer as $$
declare
  v_xp    int;
  v_level int;
  v_new_level int;
begin
  update public.child_profiles
  set    total_xp = total_xp + p_xp
  where  id = p_child_id
  returning total_xp, level into v_xp, v_level;

  -- Simple level thresholds: level = floor(sqrt(total_xp / 50)) + 1, capped at 100
  v_new_level := least(100, floor(sqrt(v_xp::numeric / 50))::int + 1);

  if v_new_level > v_level then
    update public.child_profiles
    set    level = v_new_level
    where  id = p_child_id;
  end if;

  return query select v_xp, v_new_level, (v_new_level > v_level);
end;
$$;


-- ─── Helper: upsert Word Tome entry ──────────────────────────

create or replace function public.record_word_learned(
  p_child_id        uuid,
  p_word            text,
  p_definition      text,
  p_exemplar_object text
)
returns void
language plpgsql security definer as $$
begin
  insert into public.word_tome (child_id, word, definition, exemplar_object)
  values (p_child_id, p_word, p_definition, p_exemplar_object)
  on conflict (child_id, word) do update
    set times_used      = word_tome.times_used + 1,
        last_used_at    = now(),
        exemplar_object = excluded.exemplar_object;
end;
$$;


-- ─── Seed data: starter quest ────────────────────────────────

insert into public.quests (name, enemy_name, enemy_emoji, room_label, min_age_band, required_properties)
values (
  'The Boredom Behemoth',
  'Boredom Behemoth',
  '👾',
  'Living Room',
  '7-8',
  '[
    {
      "word": "fibrous",
      "definition": "Made of or resembling fibres — long thread-like strands",
      "evaluationHints": "Fabric, rope, cardboard, wood grain all qualify. Smooth plastic does not."
    },
    {
      "word": "translucent",
      "definition": "Allows light to pass through, but not completely clear",
      "evaluationHints": "Glass and water qualify. Frosted glass barely qualifies. Opaque ceramic does not."
    },
    {
      "word": "resonant",
      "definition": "Produces a deep, clear sound when struck",
      "evaluationHints": "Metal bowls, bells, wood blocks qualify. Soft fabric does not."
    }
  ]'::jsonb
);
