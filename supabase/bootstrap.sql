-- ============================================================================
-- supabase/bootstrap.sql
-- Lexi-Lens — fresh-database provisioning script
--
-- WHY THIS FILE EXISTS:
--   supabase/schema.sql is a Supabase Dashboard introspection dump — useful
--   for context but NOT runnable as-is (header literally says "is not meant
--   to be run"). It lists tables but loses RPC function bodies and triggers.
--
--   This file is the runnable bootstrap: a fresh Supabase project + this
--   script + the migrations in supabase/migrations/ = a working database
--   that the app can talk to. Run order:
--
--     1. supabase/migrations/20240101000000_coppa_gdpr_compliance.sql
--     2. supabase/migrations/20260428_analytics.sql
--     3. supabase/migrations/20260504_quest_completions_unique_mode.sql
--     4. supabase/bootstrap.sql  (this file)
--
-- The migrations create some tables and the COPPA trigger; this file
-- creates the rest of the schema, the custom RPC functions, the GRANT
-- EXECUTE statements (without which authenticated users can't call
-- security-definer RPCs), and the seed quest data.
--
-- IDEMPOTENCY: every CREATE uses IF NOT EXISTS or OR REPLACE. Safe to re-run.
--
-- TO COMPLETE THIS FILE:
--   The RPC function bodies cannot be hand-written safely — small differences
--   from production (an off-by-one in award_xp's level formula, a wrong CHECK
--   constraint, etc.) would break the app silently. Instead, run
--   bootstrap_extract_functions.sql against the live Supabase, copy each
--   pg_get_functiondef result, and paste into the marked placeholder
--   sections below. Each placeholder is clearly labelled.
-- ============================================================================

BEGIN;

-- ─── 1. Extensions ───────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── 2. Custom types ─────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE quest_tier AS ENUM ('apprentice', 'scholar', 'sage', 'archmage');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── 3. Tables ───────────────────────────────────────────────────────────────
-- Verbatim from supabase/schema.sql. Tables that already exist (from earlier
-- migrations) are guarded by IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS public.child_profiles (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  parent_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  age_band     text NOT NULL CHECK (age_band = ANY (ARRAY['5-6'::text, '7-8'::text, '9-10'::text, '11-12'::text, '13-14'::text])),
  avatar_key   text,
  level        int  NOT NULL DEFAULT 1 CHECK (level >= 1),
  total_xp     int  NOT NULL DEFAULT 0 CHECK (total_xp >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.child_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "parent reads own children" ON public.child_profiles;
CREATE POLICY "parent reads own children"
  ON public.child_profiles FOR SELECT
  USING (parent_id = auth.uid());

DROP POLICY IF EXISTS "parent inserts own children" ON public.child_profiles;
CREATE POLICY "parent inserts own children"
  ON public.child_profiles FOR INSERT
  WITH CHECK (parent_id = auth.uid());

DROP POLICY IF EXISTS "parent updates own children" ON public.child_profiles;
CREATE POLICY "parent updates own children"
  ON public.child_profiles FOR UPDATE
  USING      (parent_id = auth.uid())
  WITH CHECK (parent_id = auth.uid());

DROP POLICY IF EXISTS "parent deletes own children" ON public.child_profiles;
CREATE POLICY "parent deletes own children"
  ON public.child_profiles FOR DELETE
  USING (parent_id = auth.uid());

-- ── quests ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.quests (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                 text NOT NULL,
  enemy_name           text NOT NULL,
  enemy_emoji          text NOT NULL,
  room_label           text NOT NULL,
  min_age_band         text NOT NULL CHECK (min_age_band = ANY (ARRAY['5-6'::text, '7-8'::text, '9-10'::text, '11-12'::text, '13-14'::text])),
  xp_reward_first_try  int  NOT NULL DEFAULT 40,
  xp_reward_retry      int  NOT NULL DEFAULT 20,
  xp_reward_third_plus int  NOT NULL DEFAULT 10,
  required_properties  jsonb NOT NULL DEFAULT '[]'::jsonb,
  hard_mode_properties jsonb NOT NULL DEFAULT '[]'::jsonb,
  age_band_properties  jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active            bool NOT NULL DEFAULT true,
  tier                 quest_tier NOT NULL DEFAULT 'apprentice',
  tier_sort_order      int  NOT NULL DEFAULT 1,
  sort_order           int  NOT NULL DEFAULT 8,
  spell_name           text,
  weapon_emoji         text,
  spell_description    text,
  created_by           uuid REFERENCES auth.users(id),
  visibility           text NOT NULL DEFAULT 'public' CHECK (visibility = ANY (ARRAY['public'::text, 'private'::text, 'pending_approval'::text])),
  approved_at          timestamptz,
  approved_by          uuid REFERENCES auth.users(id),
  target_child_id      uuid REFERENCES public.child_profiles(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.quests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anyone reads public + own private quests" ON public.quests;
CREATE POLICY "anyone reads public + own private quests"
  ON public.quests FOR SELECT
  USING (
    is_active
    AND (
      visibility = 'public'
      OR (visibility = 'private' AND created_by = auth.uid())
    )
  );

DROP POLICY IF EXISTS "parent inserts own quests" ON public.quests;
CREATE POLICY "parent inserts own quests"
  ON public.quests FOR INSERT
  WITH CHECK (created_by = auth.uid());

-- ── word_tome ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.word_tome (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  child_id            uuid NOT NULL REFERENCES public.child_profiles(id) ON DELETE CASCADE,
  word                text NOT NULL,
  definition          text NOT NULL,
  exemplar_object     text NOT NULL,
  times_used          int  NOT NULL DEFAULT 1 CHECK (times_used >= 1),
  first_used_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  mastery_score       double precision NOT NULL DEFAULT 0.0 CHECK (mastery_score >= 0.0 AND mastery_score <= 1.0),
  mastery_updated_at  timestamptz,
  is_retired          bool NOT NULL DEFAULT false,
  retired_synonym     text,
  retired_synonym_def text
);

CREATE UNIQUE INDEX IF NOT EXISTS word_tome_child_word_idx
  ON public.word_tome (child_id, lower(word));

ALTER TABLE public.word_tome ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "parent reads own children's words" ON public.word_tome;
CREATE POLICY "parent reads own children's words"
  ON public.word_tome FOR SELECT
  USING (
    child_id IN (SELECT id FROM public.child_profiles WHERE parent_id = auth.uid())
  );

-- ── quest_completions ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.quest_completions (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  child_id      uuid NOT NULL REFERENCES public.child_profiles(id) ON DELETE CASCADE,
  quest_id      uuid NOT NULL REFERENCES public.quests(id),
  mode          text NOT NULL CHECK (mode IN ('normal', 'hard')),
  total_xp      int  NOT NULL CHECK (total_xp >= 0),
  attempt_count int  NOT NULL DEFAULT 1,
  completed_at  timestamptz NOT NULL DEFAULT now()
);

-- UNIQUE constraint matching the upsert's onConflict in markQuestCompletion.
-- The 20260504_quest_completions_unique_mode.sql migration installs this,
-- but we add it here too so a fresh-clone bootstrap doesn't depend on that
-- migration having been run yet.
DO $$ BEGIN
  CREATE UNIQUE INDEX quest_completions_child_quest_mode_uidx
    ON public.quest_completions (child_id, quest_id, mode);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

ALTER TABLE public.quest_completions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "parent reads own children's completions" ON public.quest_completions;
CREATE POLICY "parent reads own children's completions"
  ON public.quest_completions FOR SELECT
  USING (
    child_id IN (SELECT id FROM public.child_profiles WHERE parent_id = auth.uid())
  );

-- ── child_streaks ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.child_streaks (
  child_id        uuid PRIMARY KEY REFERENCES public.child_profiles(id) ON DELETE CASCADE,
  current_streak  int  NOT NULL DEFAULT 0,
  longest_streak  int  NOT NULL DEFAULT 0,
  last_quest_date date,
  streak_dates    text[] NOT NULL DEFAULT '{}',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.child_streaks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "parent reads own children's streaks" ON public.child_streaks;
CREATE POLICY "parent reads own children's streaks"
  ON public.child_streaks FOR SELECT
  USING (
    child_id IN (SELECT id FROM public.child_profiles WHERE parent_id = auth.uid())
  );

-- ── daily_quests ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.daily_quests (
  quest_date date PRIMARY KEY,
  quest_id   uuid NOT NULL REFERENCES public.quests(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.daily_quests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anyone reads daily quest" ON public.daily_quests;
CREATE POLICY "anyone reads daily quest" ON public.daily_quests FOR SELECT USING (true);

-- ── spell_unlocks ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.spell_unlocks (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  child_id           uuid NOT NULL REFERENCES public.child_profiles(id) ON DELETE CASCADE,
  quest_id           uuid NOT NULL REFERENCES public.quests(id),
  quest_name         text NOT NULL,
  spell_name         text,
  weapon_emoji       text,
  spell_description  text,
  enemy_name         text NOT NULL,
  enemy_emoji        text NOT NULL,
  room_label         text NOT NULL,
  tier               quest_tier NOT NULL,
  first_unlocked_at  timestamptz NOT NULL DEFAULT now(),
  best_xp            int  NOT NULL DEFAULT 0,
  completion_count   int  NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS spell_unlocks_child_quest_uidx
  ON public.spell_unlocks (child_id, quest_id);

ALTER TABLE public.spell_unlocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "parent reads own children's unlocks" ON public.spell_unlocks;
CREATE POLICY "parent reads own children's unlocks"
  ON public.spell_unlocks FOR SELECT
  USING (
    child_id IN (SELECT id FROM public.child_profiles WHERE parent_id = auth.uid())
  );

-- ── achievements ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.achievements (
  id        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  child_id  uuid NOT NULL REFERENCES public.child_profiles(id) ON DELETE CASCADE,
  badge_id  text NOT NULL,
  earned_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS achievements_child_badge_uidx
  ON public.achievements (child_id, badge_id);

ALTER TABLE public.achievements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "parent reads own children's achievements" ON public.achievements;
CREATE POLICY "parent reads own children's achievements"
  ON public.achievements FOR SELECT
  USING (
    child_id IN (SELECT id FROM public.child_profiles WHERE parent_id = auth.uid())
  );

-- ── scan_attempts ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.scan_attempts (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  child_id          uuid NOT NULL REFERENCES public.child_profiles(id),
  quest_id          uuid REFERENCES public.quests(id),
  detected_label    text NOT NULL,
  vision_confidence numeric CHECK (vision_confidence >= 0 AND vision_confidence <= 1),
  resolved_name     text,
  overall_match     bool,
  property_scores   jsonb,
  child_feedback    text,
  xp_awarded        int  NOT NULL DEFAULT 0 CHECK (xp_awarded >= 0),
  vision_latency_ms int,
  claude_latency_ms int,
  ip_hash           text,
  rate_limited      bool NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.scan_attempts ENABLE ROW LEVEL SECURITY;

-- ── ip_rate_limits ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ip_rate_limits (
  ip_hash       text PRIMARY KEY,
  request_count int  NOT NULL DEFAULT 1,
  window_start  timestamptz NOT NULL DEFAULT now()
);

-- ── word_domains ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.word_domains (
  word          text PRIMARY KEY CHECK (word = lower(word)),
  domain        text NOT NULL CHECK (domain = ANY (ARRAY['texture'::text, 'colour'::text, 'structure'::text, 'sound'::text, 'shape'::text, 'material'::text, 'other'::text])),
  confidence    text CHECK (confidence IS NULL OR (confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text]))),
  classified_at timestamptz NOT NULL DEFAULT now(),
  classified_by text DEFAULT 'claude-haiku-4-5-20251001'
);

-- (game_sessions, quest_sessions, word_outcomes are created by the analytics
-- migration. parental_consents, data_deletion_requests, privacy_policy_versions
-- are created by the COPPA migration.)


-- ============================================================================
-- 4. RPC functions
--
-- ⚠ PASTE THE BODIES FROM bootstrap_extract_functions.sql HERE.
--
-- Each function below has a placeholder marker. After running the extract
-- script, replace each marker with the matching pg_get_functiondef output.
-- ============================================================================

-- ─── award_xp(p_child_id uuid, p_xp int) ─────────────────────────────────────
-- Atomically credits xp to a child profile and recomputes their level.
-- Called from gameStore.markQuestCompletion after quest_completions upsert.

CREATE OR REPLACE FUNCTION public.award_xp(p_child_id uuid, p_xp integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE child_profiles
  SET
    total_xp = COALESCE(total_xp, 0) + p_xp,
    level    = LEAST(100, FLOOR(SQRT((COALESCE(total_xp, 0) + p_xp) / 50.0))::INTEGER + 1)
  WHERE id = p_child_id;
END;
$function$



-- ─── record_word_learned(p_child_id uuid, p_word text, p_definition text, p_exemplar_object text) ─
-- Idempotent insert into word_tome. ON CONFLICT (child_id, lower(word))
-- increments times_used and updates last_used_at + exemplar_object.
-- SECURITY DEFINER. Called from gameStore.addWordToTome.

CREATE OR REPLACE FUNCTION public.record_word_learned(p_child_id uuid, p_word text, p_definition text, p_exemplar_object text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  insert into public.word_tome (child_id, word, definition, exemplar_object)
  values (p_child_id, p_word, p_definition, p_exemplar_object)
  on conflict (child_id, word) do update
    set times_used      = word_tome.times_used + 1,
        last_used_at    = now(),
        exemplar_object = excluded.exemplar_object;
end;
$function$



-- ─── record_daily_completion(p_child_id uuid, p_date date) ────────────────────
-- Updates child_streaks for daily quest completion. Returns
-- (new_streak, longest_streak, got_multiplier).
-- Called from gameStore.recordDailyCompletion.

CREATE OR REPLACE FUNCTION public.record_daily_completion(p_child_id uuid, p_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(new_streak integer, longest_streak integer, got_multiplier boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row            child_streaks%ROWTYPE;
  v_new_streak     int;
  v_longest        int;
  v_got_multiplier boolean;
BEGIN
  -- Fetch or initialise the streak row
  SELECT * INTO v_row FROM child_streaks WHERE child_id = p_child_id;

  IF NOT FOUND THEN
    INSERT INTO child_streaks (child_id) VALUES (p_child_id)
    RETURNING * INTO v_row;
  END IF;

  -- Idempotency guard: already recorded today
  IF v_row.last_quest_date = p_date THEN
    RETURN QUERY SELECT
      v_row.current_streak,
      v_row.longest_streak,
      (v_row.current_streak >= 7);
    RETURN;
  END IF;

  -- Calculate new streak
  IF v_row.last_quest_date = p_date - 1 THEN
    -- Consecutive day → extend
    v_new_streak := v_row.current_streak + 1;
  ELSE
    -- Gap → restart
    v_new_streak := 1;
  END IF;

  v_longest        := GREATEST(v_new_streak, v_row.longest_streak);
  v_got_multiplier := (v_new_streak >= 7);

  -- Persist (keep last 30 dates for heatmap)
  UPDATE child_streaks SET
    current_streak  = v_new_streak,
    longest_streak  = v_longest,
    last_quest_date = p_date,
    streak_dates    = (
      SELECT ARRAY(
        SELECT DISTINCT unnest(streak_dates || ARRAY[p_date])
        ORDER BY 1 DESC
        LIMIT 30
      )
    ),
    updated_at      = now()
  WHERE child_id = p_child_id;

  RETURN QUERY SELECT v_new_streak, v_longest, v_got_multiplier;
END;
$function$



-- ─── get_daily_scan_count(p_child_id uuid) ────────────────────────────────────
-- Returns the number of scan_attempts for a child in the current UTC day.
-- Called from supabase/functions/evaluate/index.ts (Section 3 quota check).

CREATE OR REPLACE FUNCTION public.get_daily_scan_count(p_child_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(COUNT(*), 0)::integer
  FROM public.scan_attempts
  WHERE child_id    = p_child_id
    AND rate_limited = false
    AND created_at  >= date_trunc('day', now() AT TIME ZONE 'UTC')
    AND created_at  <  date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day';
$function$



-- ─── update_word_mastery(p_child_id uuid, p_word text, p_success bool) ────────
-- Adjusts word_tome.mastery_score using a Bayesian-ish update.
-- Returns the new mastery_score. Called from services/MasteryService.ts.

CREATE OR REPLACE FUNCTION public.update_word_mastery(p_child_id uuid, p_word text, p_success boolean)
 RETURNS double precision
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$DECLARE
  v_current  FLOAT;
  v_new      FLOAT;
BEGIN
  SELECT mastery_score
  INTO   v_current
  FROM   word_tome
  WHERE  child_id = p_child_id
    AND  word     = p_word
    AND  NOT is_retired
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN 0.0;
  END IF;

  IF p_success THEN
    v_new := LEAST(1.0, v_current + (1.0 - v_current) * 0.20);
  ELSE
    v_new := GREATEST(0.0, v_current - 0.08);
  END IF;

  UPDATE word_tome
  SET    mastery_score      = v_new,
         mastery_updated_at = NOW(),
         times_used         = times_used + (CASE WHEN p_success THEN 1 ELSE 0 END),
         last_used_at       = NOW()
  WHERE  child_id = p_child_id
    AND  word     = p_word
    AND  NOT is_retired;

  RETURN v_new;
END;$function$



-- ============================================================================
-- 5. GRANT EXECUTE
--
-- The v4.3 work uncovered that record_word_learned was failing in production
-- with "permission denied" — the function existed as SECURITY DEFINER but
-- Postgres rejects security-definer calls before the body runs unless EXECUTE
-- is granted to the calling role (in our case, authenticated).
--
-- All SECURITY DEFINER functions need this grant. If you add a new one,
-- remember to add a GRANT line here too.
-- ============================================================================

GRANT EXECUTE ON FUNCTION public.award_xp(uuid, int)                                           TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_word_learned(uuid, text, text, text)                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_daily_completion(uuid, date)                          TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_daily_scan_count(uuid)                                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_word_mastery(uuid, text, bool)                        TO authenticated;


-- ============================================================================
-- 6. Seed data
--
-- The launch quest library. Real production has ~75 quests — this file
-- doesn't ship the full set (would be ~3000 lines of SQL). For a fresh
-- bootstrap you have two options:
--
--   (a) Export from production:
--       SELECT 'INSERT INTO public.quests (...) VALUES (...);' FROM public.quests;
--       Save output to supabase/seed_quests.sql, run after bootstrap.sql.
--
--   (b) Start with the apprentice-tier quests below (enough to test the
--       full game loop end-to-end on a fresh DB) and let the AI Quest
--       generator build out the library from there.
--
-- We ship two sample apprentice quests as a sanity-check seed. ParentDashboard
-- → AI Quest Creator can produce more once the app is running.
-- ============================================================================

INSERT INTO public.quests (
  name, enemy_name, enemy_emoji, room_label, min_age_band,
  required_properties, hard_mode_properties, age_band_properties,
  tier, sort_order, spell_name, weapon_emoji, spell_description
)
SELECT * FROM (VALUES
  (
    'The Boredom Behemoth',
    'Boredom Behemoth',
    '😩',
    'Living Room',
    '5-6',
    '[
      {"word": "soft",   "definition": "easy to press or squeeze, not hard"},
      {"word": "fluffy", "definition": "light and full of air, like a cloud"},
      {"word": "warm",   "definition": "not cold, gives a cozy feeling"}
    ]'::jsonb,
    '[]'::jsonb,
    '{}'::jsonb,
    'apprentice'::quest_tier,
    1,
    'Cushion of Comfort',
    '🛋️',
    'A spell that turns dull moments into cozy adventures.'
  ),
  (
    'The Dusty Dragon',
    'Dusty Dragon',
    '🐉',
    'Bookshelf',
    '5-6',
    '[
      {"word": "rough",       "definition": "not smooth, bumpy when you touch it"},
      {"word": "old",         "definition": "has been around for a long time"},
      {"word": "rectangular", "definition": "shaped like a rectangle, four corners"}
    ]'::jsonb,
    '[]'::jsonb,
    '{}'::jsonb,
    'apprentice'::quest_tier,
    2,
    'Tome of Tales',
    '📚',
    'A spell that wakes up forgotten stories from old places.'
  )
) AS seed(name, enemy_name, enemy_emoji, room_label, min_age_band,
          required_properties, hard_mode_properties, age_band_properties,
          tier, sort_order, spell_name, weapon_emoji, spell_description)
WHERE NOT EXISTS (SELECT 1 FROM public.quests LIMIT 1);

-- Seed the privacy policy version row (also seeded by the COPPA migration —
-- ON CONFLICT DO NOTHING handles the double-seed cleanly).
INSERT INTO public.privacy_policy_versions (version, effective_date, summary_of_changes)
VALUES (
  '1.0',
  CURRENT_DATE,
  'Initial COPPA- and GDPR-K-compliant privacy policy.'
)
ON CONFLICT (version) DO NOTHING;


COMMIT;

-- ============================================================================
-- POST-RUN VERIFICATION
-- ============================================================================
--
-- After running this file plus the migrations, run these checks:
--
-- 1. Tables present:
--    SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public' ORDER BY table_name;
--    Should list: achievements, child_profiles, child_streaks, daily_quests,
--    data_deletion_requests, game_sessions, ip_rate_limits, parental_consents,
--    privacy_policy_versions, quest_completions, quest_sessions, quests,
--    scan_attempts, spell_unlocks, word_domains, word_outcomes, word_tome.
--
-- 2. RPC functions callable by authenticated:
--    SELECT proname, has_function_privilege('authenticated', oid, 'EXECUTE') AS can_call
--    FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace
--      AND proname IN ('award_xp', 'record_word_learned', 'record_daily_completion',
--                      'get_daily_scan_count', 'update_word_mastery');
--    All five must show can_call = true.
--
-- 3. Sample quests seeded:
--    SELECT name, tier FROM public.quests ORDER BY sort_order;
--    Should show at least the two apprentice quests above.
