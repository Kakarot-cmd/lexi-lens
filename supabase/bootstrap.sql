-- ════════════════════════════════════════════════════════════════════════════
-- supabase/bootstrap.sql
-- Lexi-Lens — fresh-database provisioning script
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS:
--   Auto-derived from supabase/schema.sql (which is itself a pg_dump of
--   staging) with idempotency wrappers added. Run this against a fresh
--   Supabase project to provision the public schema to match staging.
--
-- WHAT IT CREATES:
--   19 tables, 7 views, 14 functions, 3 triggers, 49 RLS policies, 25 indexes,
--   plus the privacy_policy_versions seed row.
--
-- WHAT IT DOES NOT CREATE:
--   • The launch quest seed (~75 rows) — copy from staging via psql:
--       psql "<staging>" -c "\copy quests TO '/tmp/quests.csv' CSV HEADER"
--       psql "<prod>"    -c "\copy quests FROM '/tmp/quests.csv' CSV HEADER"
--     Or use the Apprentice-tier sample seed at the bottom of this file as a
--     starting point.
--   • Auth schema / Supabase auth.users — managed by Supabase automatically.
--   • Edge Function secrets — set via supabase secrets set (see ENVIRONMENTS.md).
--   • pg_cron job for scheduled deletions — created by the COPPA migration
--     (supabase/migrations/20240101000000_coppa_gdpr_compliance.sql).
--
-- IDEMPOTENCY:
--   Every CREATE uses IF NOT EXISTS, OR REPLACE, or duplicate-object guards.
--   Safe to re-run.
--
-- RUN ORDER:
--   1. supabase/migrations/20240101000000_coppa_gdpr_compliance.sql  (creates pg_cron job)
--   2. supabase/bootstrap.sql  (this file — creates everything else, idempotently)
--   3. supabase/seed_quests.sql  (optional — full launch quest library)
--
--   Older migrations in supabase/migrations/ are subsumed by this bootstrap
--   for fresh-DB provisioning. They remain in the migrations folder as
--   historical record.
--
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── Session settings ───────────────────────────────────────────────────────
-- check_function_bodies = false lets us define functions before the tables
-- they reference. pg_dump emits objects in dependency-tolerant order
-- (functions first, then tables), and without this setting Postgres validates
-- function bodies at CREATE time and rejects forward references.

SET LOCAL check_function_bodies = false;

-- ─── Extensions ─────────────────────────────────────────────────────────────
-- Supabase enables some of these by default but not all. Idempotent — these
-- run cleanly whether the extension is already enabled or not. The
-- `extensions` schema is Supabase's convention for hosting extension
-- functions; the schema itself is created automatically by Supabase.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto"  SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "pg_trgm"   SCHEMA extensions;

DO $bootstrap_type$ BEGIN
  CREATE TYPE public.quest_tier AS ENUM (
    'apprentice',
    'scholar',
    'sage',
    'archmage'
);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_type$;

CREATE OR REPLACE FUNCTION public.approve_quest(p_quest_id uuid, p_admin_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$

BEGIN

  UPDATE quests

  SET visibility  = 'public',

      approved_at = NOW(),

      approved_by  = p_admin_id

  WHERE id = p_quest_id

    AND visibility = 'pending_approval';

END;

$$;

CREATE OR REPLACE FUNCTION public.award_xp(p_child_id uuid, p_xp integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$

BEGIN

  UPDATE child_profiles

  SET

    total_xp = COALESCE(total_xp, 0) + p_xp,

    level    = LEAST(100, FLOOR(SQRT((COALESCE(total_xp, 0) + p_xp) / 50.0))::INTEGER + 1)

  WHERE id = p_child_id;

END;

$$;

CREATE OR REPLACE FUNCTION public.get_daily_scan_count(p_child_id uuid) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$

  SELECT COALESCE(COUNT(*), 0)::integer

  FROM public.scan_attempts

  WHERE child_id     = p_child_id

    AND rate_limited = false

    AND cache_hit    = false  -- NEW: cache hits don't count toward quota

    AND created_at  >= date_trunc('day', now() AT TIME ZONE 'UTC')

    AND created_at  <  date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day';

$$;

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$

begin

  insert into public.parents (id, display_name)

  values (

    new.id,

    coalesce(new.raw_user_meta_data->>'display_name', 'Parent')

  );

  return new;

end;

$$;

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$

  select exists (

    select 1 from public.admin_users where id = auth.uid()

  );

$$;

CREATE OR REPLACE FUNCTION public.purge_scheduled_deletions() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$

BEGIN

  DELETE FROM auth.users

  WHERE

    raw_app_meta_data ->> 'deletion_scheduled_at' IS NOT NULL

    AND (raw_app_meta_data ->> 'deletion_scheduled_at')::TIMESTAMPTZ < now();

END;

$$;

COMMENT ON FUNCTION public.purge_scheduled_deletions() IS 'SECURITY DEFINER helper called by pg_cron nightly. Hard-deletes parent auth.users rows whose deletion_scheduled_at has elapsed. Child data was already wiped immediately by the request-deletion Edge Function.';

CREATE OR REPLACE FUNCTION public.record_daily_completion(p_child_id uuid, p_date date DEFAULT CURRENT_DATE) RETURNS TABLE(new_streak integer, longest_streak integer, got_multiplier boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$

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

$$;

CREATE OR REPLACE FUNCTION public.record_word_learned(p_child_id uuid, p_word text, p_definition text, p_exemplar_object text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$

begin

  insert into public.word_tome (child_id, word, definition, exemplar_object)

  values (p_child_id, p_word, p_definition, p_exemplar_object)

  on conflict (child_id, word) do update

    set times_used      = word_tome.times_used + 1,

        last_used_at    = now(),

        exemplar_object = excluded.exemplar_object;

end;

$$;

CREATE OR REPLACE FUNCTION public.retire_word_and_promote(p_child_id uuid, p_word text, p_synonym text, p_synonym_def text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$BEGIN

  UPDATE word_tome

  SET    is_retired          = true,

         retired_synonym     = p_synonym,

         retired_synonym_def = p_synonym_def,

         mastery_updated_at  = NOW()

  WHERE  child_id = p_child_id

    AND  word     = p_word

    AND  NOT is_retired;

  INSERT INTO word_tome (

    child_id, word, definition, exemplar_object,

    mastery_score, times_used, first_used_at, last_used_at

  )

  SELECT

    p_child_id,

    p_synonym,

    p_synonym_def,

    (SELECT exemplar_object FROM word_tome

     WHERE child_id = p_child_id AND word = p_word

     ORDER BY last_used_at DESC LIMIT 1),

    0.0, 0, NOW(), NOW()

  ON CONFLICT (child_id, word) DO NOTHING;

END;$$;

CREATE OR REPLACE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_age_band() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$

BEGIN

  NEW.age_band := CASE

    WHEN NEW.age <= 6  THEN '5-6'

    WHEN NEW.age <= 8  THEN '7-8'

    WHEN NEW.age <= 10 THEN '9-10'

    ELSE '11-12'

  END;

  RETURN NEW;

END;

$$;

CREATE OR REPLACE FUNCTION public.sync_tier_sort_order() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$

BEGIN

  NEW.tier_sort_order := CASE NEW.tier

    WHEN 'apprentice' THEN 1

    WHEN 'scholar'    THEN 2

    WHEN 'sage'       THEN 3

    WHEN 'archmage'   THEN 4

    ELSE 99

  END;

  RETURN NEW;

END;

$$;

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$

begin

  new.updated_at = now();

  return new;

end;

$$;

CREATE OR REPLACE FUNCTION public.update_word_mastery(p_child_id uuid, p_word text, p_success boolean) RETURNS double precision
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$DECLARE

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

END;$$;

CREATE TABLE IF NOT EXISTS public.word_tome (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    child_id uuid NOT NULL,
    word text NOT NULL,
    definition text NOT NULL,
    exemplar_object text NOT NULL,
    times_used integer DEFAULT 1 NOT NULL,
    first_used_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    mastery_score double precision DEFAULT 0.0 NOT NULL,
    mastery_updated_at timestamp with time zone,
    is_retired boolean DEFAULT false NOT NULL,
    retired_synonym text,
    retired_synonym_def text,
    CONSTRAINT word_tome_mastery_score_check CHECK (((mastery_score >= (0.0)::double precision) AND (mastery_score <= (1.0)::double precision))),
    CONSTRAINT word_tome_times_used_check CHECK ((times_used >= 1))
);

CREATE OR REPLACE VIEW public.active_mastery_profile WITH (security_invoker='true') AS
 SELECT child_id,
    word,
    definition,
    mastery_score,
    times_used,
        CASE
            WHEN (mastery_score < (0.3)::double precision) THEN 'novice'::text
            WHEN (mastery_score < (0.6)::double precision) THEN 'developing'::text
            WHEN (mastery_score < (0.8)::double precision) THEN 'proficient'::text
            ELSE 'expert'::text
        END AS mastery_tier
   FROM public.word_tome
  WHERE (NOT is_retired)
  ORDER BY child_id, mastery_score;

COMMENT ON VIEW public.active_mastery_profile IS 'Per-child mastery tier roll-up. SECURITY INVOKER: respects word_tome RLS so parents see only their own children''s vocabulary.';

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
    id bigint NOT NULL,
    admin_id uuid NOT NULL,
    action text NOT NULL,
    target_id uuid,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS public.admin_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.admin_audit_log_id_seq OWNED BY public.admin_audit_log.id;

CREATE TABLE IF NOT EXISTS public.admin_users (
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.child_achievements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    child_id uuid NOT NULL,
    badge_id text NOT NULL,
    earned_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.scan_attempts (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    child_id uuid NOT NULL,
    quest_id uuid NOT NULL,
    detected_label text NOT NULL,
    vision_confidence numeric(4,3) NOT NULL,
    resolved_name text NOT NULL,
    overall_match boolean NOT NULL,
    property_scores jsonb NOT NULL,
    child_feedback text NOT NULL,
    xp_awarded integer DEFAULT 0 NOT NULL,
    vision_latency_ms integer,
    claude_latency_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_hash text,
    rate_limited boolean DEFAULT false NOT NULL,
    cache_hit boolean DEFAULT false NOT NULL,
    CONSTRAINT scan_attempts_vision_confidence_check CHECK (((vision_confidence >= (0)::numeric) AND (vision_confidence <= (1)::numeric))),
    CONSTRAINT scan_attempts_xp_awarded_check CHECK ((xp_awarded >= 0))
);

COMMENT ON COLUMN public.scan_attempts.cache_hit IS 'true when this scan was served from the Upstash Redis response cache (no Claude call). cache_hit=true rows do NOT count toward the daily 50/child quota.';

CREATE OR REPLACE VIEW public.child_daily_scan_summary WITH (security_invoker='true') AS
 SELECT child_id,
    (date_trunc('day'::text, (created_at AT TIME ZONE 'UTC'::text)))::date AS scan_date,
    count(*) AS total_scans,
    count(*) FILTER (WHERE (overall_match = true)) AS matches,
    count(*) FILTER (WHERE (overall_match = false)) AS misses,
    count(*) FILTER (WHERE (rate_limited = true)) AS rate_limited_attempts,
    min(created_at) AS first_scan_at,
    max(created_at) AS last_scan_at
   FROM public.scan_attempts
  GROUP BY child_id, ((date_trunc('day'::text, (created_at AT TIME ZONE 'UTC'::text)))::date);

COMMENT ON VIEW public.child_daily_scan_summary IS 'Daily scan roll-up per child. SECURITY INVOKER: respects scan_attempts RLS so parents see only their own children''s data.';

CREATE TABLE IF NOT EXISTS public.child_profiles (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    parent_id uuid NOT NULL,
    display_name text NOT NULL,
    age_band text NOT NULL,
    avatar_key text,
    level integer DEFAULT 1 NOT NULL,
    total_xp integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    age integer DEFAULT 8 NOT NULL,
    CONSTRAINT child_profiles_age_band_check CHECK ((age_band = ANY (ARRAY['5-6'::text, '7-8'::text, '9-10'::text, '11-12'::text]))),
    CONSTRAINT child_profiles_age_check CHECK (((age >= 5) AND (age <= 12))),
    CONSTRAINT child_profiles_display_name_check CHECK ((char_length(display_name) <= 30)),
    CONSTRAINT child_profiles_level_check CHECK (((level >= 1) AND (level <= 100))),
    CONSTRAINT child_profiles_total_xp_check CHECK ((total_xp >= 0))
);

CREATE TABLE IF NOT EXISTS public.child_streaks (
    child_id uuid NOT NULL,
    current_streak integer DEFAULT 0 NOT NULL,
    longest_streak integer DEFAULT 0 NOT NULL,
    last_quest_date date,
    streak_dates date[] DEFAULT '{}'::date[] NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.daily_quests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quest_date date NOT NULL,
    quest_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.data_deletion_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_id uuid,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    scheduled_deletion_at timestamp with time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    reason text,
    completed_at timestamp with time zone,
    children_deleted integer,
    scan_rows_deleted integer,
    mastery_rows_deleted integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT data_deletion_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'cancelled'::text])))
);

COMMENT ON TABLE public.data_deletion_requests IS 'Erasure requests initiated by parents via DataDeletionScreen. Written and updated by request-deletion Edge Function. Retained 7 years for regulatory audit trail.';

COMMENT ON COLUMN public.data_deletion_requests.parent_id IS 'NULL after account deletion — request record is intentionally retained.';

COMMENT ON COLUMN public.data_deletion_requests.scheduled_deletion_at IS 'Parent account hard-deleted by pg_cron job when this timestamp elapses.';

COMMENT ON COLUMN public.data_deletion_requests.status IS 'Lifecycle: pending → processing → completed | cancelled.';

CREATE TABLE IF NOT EXISTS public.game_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    child_id uuid NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    duration_sec integer GENERATED ALWAYS AS ((EXTRACT(epoch FROM (ended_at - started_at)))::integer) STORED,
    screen_sequence text[],
    quests_started integer DEFAULT 0 NOT NULL,
    quests_finished integer DEFAULT 0 NOT NULL,
    xp_earned integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS public.ip_rate_limits (
    ip_hash text NOT NULL,
    request_count integer DEFAULT 1 NOT NULL,
    window_start timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.parental_consents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_id uuid NOT NULL,
    policy_version text NOT NULL,
    consented_at timestamp with time zone NOT NULL,
    coppa_confirmed boolean DEFAULT false NOT NULL,
    gdpr_k_confirmed boolean DEFAULT false NOT NULL,
    ai_processing_confirmed boolean DEFAULT false NOT NULL,
    parental_gate_passed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.parental_consents IS 'One row per parent per policy version. Written by on_auth_user_created_consent trigger at signup. Retained 7 years. References auth.users with ON DELETE SET NULL so consent evidence survives account erasure.';

COMMENT ON COLUMN public.parental_consents.parent_id IS 'NULL after account deletion — consent record is intentionally retained.';

COMMENT ON COLUMN public.parental_consents.policy_version IS 'Matches privacy_policy_versions.version. Stored as TEXT (not FK) to survive future policy table truncation.';

COMMENT ON COLUMN public.parental_consents.coppa_confirmed IS 'Parent confirmed they are 18+ and a parent/guardian (COPPA §312.5).';

COMMENT ON COLUMN public.parental_consents.gdpr_k_confirmed IS 'Parent confirmed GDPR-K Art. 8 processing consent and right to withdraw.';

COMMENT ON COLUMN public.parental_consents.ai_processing_confirmed IS 'Parent confirmed AI processes object labels only — no PII, no images stored.';

COMMENT ON COLUMN public.parental_consents.parental_gate_passed IS 'Parent solved the randomised arithmetic challenge in ConsentGateModal.';

CREATE TABLE IF NOT EXISTS public.parents (
    id uuid NOT NULL,
    display_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.quests (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    enemy_name text NOT NULL,
    enemy_emoji text NOT NULL,
    room_label text NOT NULL,
    min_age_band text NOT NULL,
    xp_reward_first_try integer DEFAULT 40 NOT NULL,
    xp_reward_retry integer DEFAULT 20 NOT NULL,
    required_properties jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    hard_mode_properties jsonb DEFAULT '[]'::jsonb NOT NULL,
    tier public.quest_tier DEFAULT 'apprentice'::public.quest_tier NOT NULL,
    tier_sort_order integer DEFAULT 1 NOT NULL,
    age_band_properties jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    visibility text DEFAULT 'public'::text NOT NULL,
    approved_at timestamp with time zone,
    approved_by uuid,
    sort_order integer DEFAULT 8 NOT NULL,
    spell_name text,
    weapon_emoji text,
    spell_description text,
    target_child_id uuid,
    xp_reward_third_plus integer DEFAULT 10 NOT NULL,
    CONSTRAINT quests_min_age_band_check CHECK ((min_age_band = ANY (ARRAY['5-6'::text, '7-8'::text, '9-10'::text, '11-12'::text, '13-14'::text]))),
    CONSTRAINT quests_tier_check CHECK ((tier = ANY (ARRAY['apprentice'::public.quest_tier, 'scholar'::public.quest_tier, 'sage'::public.quest_tier, 'archmage'::public.quest_tier]))),
    CONSTRAINT quests_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text, 'pending_approval'::text])))
);

COMMENT ON COLUMN public.quests.hard_mode_properties IS 'Harder synonym set for quest replay. Same shape as required_properties.

   Leave [] to disable Hard Mode replay for this quest.';

COMMENT ON COLUMN public.quests.target_child_id IS 'NULL = visible to all children of the creator. UUID = only that child.';

CREATE OR REPLACE VIEW public.pending_quests WITH (security_invoker='true') AS
 SELECT id,
    name,
    enemy_name,
    enemy_emoji,
    room_label,
    min_age_band,
    xp_reward_first_try,
    xp_reward_retry,
    required_properties,
    is_active,
    created_at,
    hard_mode_properties,
    tier,
    tier_sort_order,
    age_band_properties,
    created_by,
    visibility,
    approved_at,
    approved_by
   FROM public.quests q
  WHERE ((visibility = 'pending_approval'::text) AND (approved_at IS NULL));

COMMENT ON VIEW public.pending_quests IS 'Pending quest moderation list. Admin-only. Removes auth.users join that previously leaked all parent emails to every authenticated user.';

CREATE TABLE IF NOT EXISTS public.privacy_policy_versions (
    version text NOT NULL,
    effective_date date NOT NULL,
    summary_of_changes text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.privacy_policy_versions IS 'Immutable registry of published Lexi-Lens privacy policy versions. Referenced by parental_consents.policy_version. Retained indefinitely.';

CREATE TABLE IF NOT EXISTS public.quest_completions (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    child_id uuid NOT NULL,
    quest_id uuid NOT NULL,
    total_xp integer NOT NULL,
    attempt_count integer DEFAULT 1 NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL,
    mode text DEFAULT 'normal'::text NOT NULL,
    CONSTRAINT quest_completions_mode_check CHECK ((mode = ANY (ARRAY['normal'::text, 'hard'::text])))
);

COMMENT ON TABLE public.quest_completions IS 'Records each child completing a quest in normal or hard mode.

   Used by QuestMapScreen to show replay / hard-mode buttons.';

CREATE TABLE IF NOT EXISTS public.quest_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    child_id uuid NOT NULL,
    quest_id uuid NOT NULL,
    game_session_id uuid,
    hard_mode boolean DEFAULT false NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    completed boolean DEFAULT false NOT NULL,
    total_scans integer DEFAULT 0 NOT NULL,
    xp_awarded integer DEFAULT 0 NOT NULL
);

CREATE OR REPLACE VIEW public.quest_dropoff WITH (security_invoker='true') AS
 SELECT q.id AS quest_id,
    q.name AS quest_name,
    count(qs.id) AS starts,
    count(qs.id) FILTER (WHERE qs.completed) AS completions,
    round((((count(qs.id) FILTER (WHERE qs.completed))::numeric / (NULLIF(count(qs.id), 0))::numeric) * (100)::numeric), 1) AS completion_pct
   FROM (public.quests q
     LEFT JOIN public.quest_sessions qs ON ((qs.quest_id = q.id)))
  GROUP BY q.id, q.name
  ORDER BY (round((((count(qs.id) FILTER (WHERE qs.completed))::numeric / (NULLIF(count(qs.id), 0))::numeric) * (100)::numeric), 1));

COMMENT ON VIEW public.quest_dropoff IS 'Quest funnel analytics. Admin-only — service_role grant only.';

CREATE OR REPLACE VIEW public.session_length_by_age WITH (security_invoker='true') AS
 SELECT
        CASE
            WHEN ((cp.age >= 5) AND (cp.age <= 7)) THEN '5-7'::text
            WHEN ((cp.age >= 8) AND (cp.age <= 10)) THEN '8-10'::text
            WHEN ((cp.age >= 11) AND (cp.age <= 13)) THEN '11-13'::text
            ELSE '14+'::text
        END AS age_band,
    count(gs.id) AS session_count,
    round((avg(gs.duration_sec) / 60.0), 1) AS avg_duration_min,
    round(avg(gs.quests_finished), 1) AS avg_quests_finished
   FROM (public.game_sessions gs
     JOIN public.child_profiles cp ON ((cp.id = gs.child_id)))
  WHERE (gs.ended_at IS NOT NULL)
  GROUP BY
        CASE
            WHEN ((cp.age >= 5) AND (cp.age <= 7)) THEN '5-7'::text
            WHEN ((cp.age >= 8) AND (cp.age <= 10)) THEN '8-10'::text
            WHEN ((cp.age >= 11) AND (cp.age <= 13)) THEN '11-13'::text
            ELSE '14+'::text
        END
  ORDER BY
        CASE
            WHEN ((cp.age >= 5) AND (cp.age <= 7)) THEN '5-7'::text
            WHEN ((cp.age >= 8) AND (cp.age <= 10)) THEN '8-10'::text
            WHEN ((cp.age >= 11) AND (cp.age <= 13)) THEN '11-13'::text
            ELSE '14+'::text
        END;

COMMENT ON VIEW public.session_length_by_age IS 'Aggregate session duration by age band. Admin-only.';

CREATE OR REPLACE VIEW public.spell_unlocks WITH (security_invoker='true') AS
 SELECT qc.child_id,
    qc.quest_id,
    q.name AS quest_name,
    COALESCE(q.spell_name, q.name) AS spell_name,
    COALESCE(q.weapon_emoji, '⚔️'::text) AS weapon_emoji,
    COALESCE(q.spell_description, ''::text) AS spell_description,
    q.enemy_name,
    q.enemy_emoji,
    q.room_label,
    q.tier,
    min(qc.completed_at) AS first_unlocked_at,
    max(qc.total_xp) AS best_xp,
    count(*) AS completion_count
   FROM (public.quest_completions qc
     JOIN public.quests q ON ((q.id = qc.quest_id)))
  GROUP BY qc.child_id, qc.quest_id, q.name, q.spell_name, q.weapon_emoji, q.spell_description, q.enemy_name, q.enemy_emoji, q.room_label, q.tier;

COMMENT ON VIEW public.spell_unlocks IS 'Per-child unlocked spell list for SpellBookScreen. SECURITY INVOKER: respects quest_completions RLS so parents see only their own children.';

CREATE TABLE IF NOT EXISTS public.word_domains (
    word text NOT NULL,
    domain text NOT NULL,
    confidence text,
    classified_at timestamp with time zone DEFAULT now() NOT NULL,
    classified_by text DEFAULT 'claude-haiku-4-5-20251001'::text,
    CONSTRAINT word_domains_confidence_chk CHECK (((confidence IS NULL) OR (confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])))),
    CONSTRAINT word_domains_domain_chk CHECK ((domain = ANY (ARRAY['texture'::text, 'colour'::text, 'structure'::text, 'sound'::text, 'shape'::text, 'material'::text, 'other'::text]))),
    CONSTRAINT word_domains_word_lowercase_chk CHECK ((word = lower(word)))
);

COMMENT ON TABLE public.word_domains IS 'Global word→sensory-domain map for the Mastery Radar (N3). One row per

   unique word. Populated by the classify-words Edge Function, read by

   masteryRadarService.ts. Word casing is normalised lowercase by writers.';

CREATE TABLE IF NOT EXISTS public.word_outcomes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    child_id uuid NOT NULL,
    quest_id uuid,
    word text NOT NULL,
    passed boolean NOT NULL,
    scan_label text,
    attempt_num integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE OR REPLACE VIEW public.word_fail_rates WITH (security_invoker='true') AS
 SELECT word,
    count(*) AS total_attempts,
    count(*) FILTER (WHERE (NOT passed)) AS fail_count,
    round((((count(*) FILTER (WHERE (NOT passed)))::numeric / (count(*))::numeric) * (100)::numeric), 1) AS fail_pct
   FROM public.word_outcomes
  GROUP BY word
 HAVING (count(*) >= 5)
  ORDER BY (round((((count(*) FILTER (WHERE (NOT passed)))::numeric / (count(*))::numeric) * (100)::numeric), 1)) DESC;

COMMENT ON VIEW public.word_fail_rates IS 'Aggregate vocabulary difficulty by word. SECURITY INVOKER, no PII.';

ALTER TABLE ONLY public.admin_audit_log ALTER COLUMN id SET DEFAULT nextval('public.admin_audit_log_id_seq'::regclass);

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.child_achievements
    ADD CONSTRAINT child_achievements_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.child_achievements
    ADD CONSTRAINT child_achievements_unique UNIQUE (child_id, badge_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.child_profiles
    ADD CONSTRAINT child_profiles_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.child_streaks
    ADD CONSTRAINT child_streaks_pkey PRIMARY KEY (child_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.daily_quests
    ADD CONSTRAINT daily_quests_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.daily_quests
    ADD CONSTRAINT daily_quests_quest_date_key UNIQUE (quest_date);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.data_deletion_requests
    ADD CONSTRAINT data_deletion_requests_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.game_sessions
    ADD CONSTRAINT game_sessions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.ip_rate_limits
    ADD CONSTRAINT ip_rate_limits_pkey PRIMARY KEY (ip_hash);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.parental_consents
    ADD CONSTRAINT parental_consents_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.parents
    ADD CONSTRAINT parents_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.privacy_policy_versions
    ADD CONSTRAINT privacy_policy_versions_pkey PRIMARY KEY (version);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.quest_completions
    ADD CONSTRAINT quest_completions_child_quest_mode_key UNIQUE (child_id, quest_id, mode);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.quest_completions
    ADD CONSTRAINT quest_completions_child_quest_mode_uniq UNIQUE (child_id, quest_id, mode);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

COMMENT ON CONSTRAINT quest_completions_child_quest_mode_uniq ON public.quest_completions IS 'Required by store/gameStore.ts → markQuestCompletion() upsert with onConflict: "child_id,quest_id,mode". Without this constraint the upsert degrades to plain INSERT, allowing duplicate rows + duplicate award_xp() calls on quest replay. Added in v4.3 (Roadmap gap #2).';

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.quest_sessions
    ADD CONSTRAINT quest_sessions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.quests
    ADD CONSTRAINT quests_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.scan_attempts
    ADD CONSTRAINT scan_attempts_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.word_domains
    ADD CONSTRAINT word_domains_pkey PRIMARY KEY (word);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.word_outcomes
    ADD CONSTRAINT word_outcomes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.word_tome
    ADD CONSTRAINT word_tome_child_id_word_key UNIQUE (child_id, word);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.word_tome
    ADD CONSTRAINT word_tome_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

CREATE INDEX IF NOT EXISTS child_achievements_child_idx ON public.child_achievements USING btree (child_id);

CREATE INDEX IF NOT EXISTS child_achievements_lookup_idx ON public.child_achievements USING btree (child_id, badge_id);

CREATE INDEX IF NOT EXISTS daily_quests_date_idx ON public.daily_quests USING btree (quest_date DESC);

CREATE INDEX IF NOT EXISTS data_deletion_requests_parent_id_idx ON public.data_deletion_requests USING btree (parent_id);

CREATE INDEX IF NOT EXISTS data_deletion_requests_scheduled_deletion_at_idx ON public.data_deletion_requests USING btree (scheduled_deletion_at) WHERE (scheduled_deletion_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS data_deletion_requests_status_idx ON public.data_deletion_requests USING btree (status);

CREATE INDEX IF NOT EXISTS idx_game_sessions_child_started ON public.game_sessions USING btree (child_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_quest_completions_child ON public.quest_completions USING btree (child_id);

CREATE INDEX IF NOT EXISTS idx_quest_completions_child_quest ON public.quest_completions USING btree (child_id, quest_id);

CREATE INDEX IF NOT EXISTS idx_quest_sessions_child_quest ON public.quest_sessions USING btree (child_id, quest_id);

CREATE INDEX IF NOT EXISTS idx_quests_created_by ON public.quests USING btree (created_by);

CREATE INDEX IF NOT EXISTS idx_quests_tier ON public.quests USING btree (tier);

CREATE INDEX IF NOT EXISTS idx_quests_visibility ON public.quests USING btree (visibility);

CREATE INDEX IF NOT EXISTS idx_word_domains_domain ON public.word_domains USING btree (domain);

CREATE INDEX IF NOT EXISTS idx_word_outcomes_child_quest ON public.word_outcomes USING btree (child_id, quest_id);

CREATE INDEX IF NOT EXISTS idx_word_outcomes_word ON public.word_outcomes USING btree (word);

CREATE INDEX IF NOT EXISTS idx_word_tome_active ON public.word_tome USING btree (child_id, is_retired) WHERE (is_retired = false);

CREATE INDEX IF NOT EXISTS idx_word_tome_child_mastery ON public.word_tome USING btree (child_id, mastery_score DESC);

CREATE INDEX IF NOT EXISTS parental_consents_parent_id_idx ON public.parental_consents USING btree (parent_id);

CREATE INDEX IF NOT EXISTS parental_consents_policy_version_idx ON public.parental_consents USING btree (policy_version);

CREATE INDEX IF NOT EXISTS quest_completions_child_idx ON public.quest_completions USING btree (child_id);

CREATE INDEX IF NOT EXISTS scan_attempts_cache_hit_created_idx ON public.scan_attempts USING btree (cache_hit, created_at DESC);

CREATE INDEX IF NOT EXISTS scan_attempts_child_date_idx ON public.scan_attempts USING btree (child_id, created_at DESC);

CREATE INDEX IF NOT EXISTS word_tome_child_idx ON public.word_tome USING btree (child_id);

CREATE INDEX IF NOT EXISTS word_tome_word_trgm ON public.word_tome USING gin (word extensions.gin_trgm_ops);

DROP TRIGGER IF EXISTS child_profiles_touch_updated_at ON public.child_profiles;
CREATE TRIGGER child_profiles_touch_updated_at BEFORE UPDATE ON public.child_profiles FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_sync_age_band ON public.child_profiles;
CREATE TRIGGER trg_sync_age_band BEFORE INSERT OR UPDATE OF age ON public.child_profiles FOR EACH ROW EXECUTE FUNCTION public.sync_age_band();

DROP TRIGGER IF EXISTS trg_tier_sort_order ON public.quests;
CREATE TRIGGER trg_tier_sort_order BEFORE INSERT OR UPDATE ON public.quests FOR EACH ROW EXECUTE FUNCTION public.sync_tier_sort_order();

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES auth.users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.child_achievements
    ADD CONSTRAINT child_achievements_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.child_profiles(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.child_profiles
    ADD CONSTRAINT child_profiles_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parents(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.child_streaks
    ADD CONSTRAINT child_streaks_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.child_profiles(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.daily_quests
    ADD CONSTRAINT daily_quests_quest_id_fkey FOREIGN KEY (quest_id) REFERENCES public.quests(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.data_deletion_requests
    ADD CONSTRAINT data_deletion_requests_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES auth.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.game_sessions
    ADD CONSTRAINT game_sessions_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.child_profiles(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.parental_consents
    ADD CONSTRAINT parental_consents_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES auth.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.parents
    ADD CONSTRAINT parents_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.quest_completions
    ADD CONSTRAINT quest_completions_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.child_profiles(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.quest_completions
    ADD CONSTRAINT quest_completions_quest_id_fkey FOREIGN KEY (quest_id) REFERENCES public.quests(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.quest_sessions
    ADD CONSTRAINT quest_sessions_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.child_profiles(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.quest_sessions
    ADD CONSTRAINT quest_sessions_game_session_id_fkey FOREIGN KEY (game_session_id) REFERENCES public.game_sessions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.quest_sessions
    ADD CONSTRAINT quest_sessions_quest_id_fkey FOREIGN KEY (quest_id) REFERENCES public.quests(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.quests
    ADD CONSTRAINT quests_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.quests
    ADD CONSTRAINT quests_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.quests
    ADD CONSTRAINT quests_target_child_id_fkey FOREIGN KEY (target_child_id) REFERENCES public.child_profiles(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.scan_attempts
    ADD CONSTRAINT scan_attempts_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.child_profiles(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.scan_attempts
    ADD CONSTRAINT scan_attempts_quest_id_fkey FOREIGN KEY (quest_id) REFERENCES public.quests(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.word_outcomes
    ADD CONSTRAINT word_outcomes_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.child_profiles(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.word_outcomes
    ADD CONSTRAINT word_outcomes_quest_id_fkey FOREIGN KEY (quest_id) REFERENCES public.quests(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DO $bootstrap_constraint$ BEGIN
  ALTER TABLE ONLY public.word_tome
    ADD CONSTRAINT word_tome_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.child_profiles(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $bootstrap_constraint$;

DROP POLICY IF EXISTS "Admins delete quests" ON public.quests;
CREATE POLICY "Admins delete quests" ON public.quests FOR DELETE TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "Admins insert quests" ON public.quests;
CREATE POLICY "Admins insert quests" ON public.quests FOR INSERT TO authenticated WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins read all quests" ON public.quests;
CREATE POLICY "Admins read all quests" ON public.quests FOR SELECT TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "Admins read audit log" ON public.admin_audit_log;
CREATE POLICY "Admins read audit log" ON public.admin_audit_log FOR SELECT TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "Admins update quests" ON public.quests;
CREATE POLICY "Admins update quests" ON public.quests FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins write audit log" ON public.admin_audit_log;
CREATE POLICY "Admins write audit log" ON public.admin_audit_log FOR INSERT TO authenticated WITH CHECK (((admin_id = auth.uid()) AND public.is_admin()));

DROP POLICY IF EXISTS "Anyone can read policy versions" ON public.privacy_policy_versions;
CREATE POLICY "Anyone can read policy versions" ON public.privacy_policy_versions FOR SELECT USING (true);

DROP POLICY IF EXISTS "No public access to admin_users" ON public.admin_users;
CREATE POLICY "No public access to admin_users" ON public.admin_users USING (false);

DROP POLICY IF EXISTS "Parent private quests visible to own children" ON public.quests;
CREATE POLICY "Parent private quests visible to own children" ON public.quests FOR SELECT USING (((visibility = 'public'::text) OR (created_by = auth.uid()) OR ((visibility = 'private'::text) AND (created_by IN ( SELECT child_profiles.parent_id
   FROM public.child_profiles
  WHERE (child_profiles.id IN ( SELECT child_profiles_1.id
           FROM public.child_profiles child_profiles_1
          WHERE (child_profiles_1.parent_id = ( SELECT child_profiles_2.parent_id
                   FROM public.child_profiles child_profiles_2
                  WHERE ((child_profiles_2.id)::text = (auth.uid())::text)
                 LIMIT 1)))))) AND ((target_child_id IS NULL) OR (target_child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = ( SELECT child_profiles_1.parent_id
           FROM public.child_profiles child_profiles_1
          WHERE (child_profiles_1.id = quests.target_child_id)
         LIMIT 1))))))));

DROP POLICY IF EXISTS "Parents can create quests" ON public.quests;
CREATE POLICY "Parents can create quests" ON public.quests FOR INSERT WITH CHECK ((created_by = auth.uid()));

DROP POLICY IF EXISTS "Parents can insert own consent records" ON public.parental_consents;
CREATE POLICY "Parents can insert own consent records" ON public.parental_consents FOR INSERT WITH CHECK ((auth.uid() = parent_id));

DROP POLICY IF EXISTS "Parents can insert own deletion requests" ON public.data_deletion_requests;
CREATE POLICY "Parents can insert own deletion requests" ON public.data_deletion_requests FOR INSERT WITH CHECK ((auth.uid() = parent_id));

DROP POLICY IF EXISTS "Parents can read own consent records" ON public.parental_consents;
CREATE POLICY "Parents can read own consent records" ON public.parental_consents FOR SELECT USING ((auth.uid() = parent_id));

DROP POLICY IF EXISTS "Parents can read own deletion requests" ON public.data_deletion_requests;
CREATE POLICY "Parents can read own deletion requests" ON public.data_deletion_requests FOR SELECT USING ((auth.uid() = parent_id));

DROP POLICY IF EXISTS "Parents can update own quests" ON public.quests;
CREATE POLICY "Parents can update own quests" ON public.quests FOR UPDATE USING ((created_by = auth.uid()));

DROP POLICY IF EXISTS "Parents insert child completions" ON public.quest_completions;
CREATE POLICY "Parents insert child completions" ON public.quest_completions FOR INSERT WITH CHECK ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

DROP POLICY IF EXISTS "Parents insert own quests" ON public.quests;
CREATE POLICY "Parents insert own quests" ON public.quests FOR INSERT TO authenticated WITH CHECK (((created_by = auth.uid()) AND (visibility = 'pending_approval'::text) AND (approved_at IS NULL)));

DROP POLICY IF EXISTS "Parents read child completions" ON public.quest_completions;
CREATE POLICY "Parents read child completions" ON public.quest_completions FOR SELECT USING ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

DROP POLICY IF EXISTS "Parents read own quests" ON public.quests;
CREATE POLICY "Parents read own quests" ON public.quests FOR SELECT TO authenticated USING ((created_by = auth.uid()));

DROP POLICY IF EXISTS "Parents update child completions" ON public.quest_completions;
CREATE POLICY "Parents update child completions" ON public.quest_completions FOR UPDATE USING ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid())))) WITH CHECK ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

DROP POLICY IF EXISTS "Parents update own quests" ON public.quests;
CREATE POLICY "Parents update own quests" ON public.quests FOR UPDATE TO authenticated USING (((created_by = auth.uid()) AND (visibility <> 'public'::text))) WITH CHECK (((created_by = auth.uid()) AND (approved_at IS NULL) AND (visibility = ANY (ARRAY['private'::text, 'pending_approval'::text]))));

DROP POLICY IF EXISTS "Public quests are readable by all" ON public.quests;
CREATE POLICY "Public quests are readable by all" ON public.quests FOR SELECT USING (((visibility = 'public'::text) AND (approved_at IS NOT NULL)));

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "child closes own session" ON public.game_sessions;
CREATE POLICY "child closes own session" ON public.game_sessions FOR UPDATE USING ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid())))) WITH CHECK ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

DROP POLICY IF EXISTS "child inserts own session" ON public.game_sessions;
CREATE POLICY "child inserts own session" ON public.game_sessions FOR INSERT WITH CHECK ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

DROP POLICY IF EXISTS "child inserts word outcomes" ON public.word_outcomes;
CREATE POLICY "child inserts word outcomes" ON public.word_outcomes FOR INSERT WITH CHECK ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

DROP POLICY IF EXISTS "child manages own quest sessions" ON public.quest_sessions;
CREATE POLICY "child manages own quest sessions" ON public.quest_sessions USING ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid())))) WITH CHECK ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

ALTER TABLE public.child_achievements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "child_achievements: parent insert own children" ON public.child_achievements;
CREATE POLICY "child_achievements: parent insert own children" ON public.child_achievements FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.child_profiles cp
  WHERE ((cp.id = child_achievements.child_id) AND (cp.parent_id = auth.uid())))));

DROP POLICY IF EXISTS "child_achievements: parent inserts" ON public.child_achievements;
CREATE POLICY "child_achievements: parent inserts" ON public.child_achievements FOR INSERT WITH CHECK ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

DROP POLICY IF EXISTS "child_achievements: parent read own children" ON public.child_achievements;
CREATE POLICY "child_achievements: parent read own children" ON public.child_achievements FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.child_profiles cp
  WHERE ((cp.id = child_achievements.child_id) AND (cp.parent_id = auth.uid())))));

DROP POLICY IF EXISTS "child_achievements: parent reads" ON public.child_achievements;
CREATE POLICY "child_achievements: parent reads" ON public.child_achievements FOR SELECT USING ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

ALTER TABLE public.child_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "child_profiles: parent owns children" ON public.child_profiles;
CREATE POLICY "child_profiles: parent owns children" ON public.child_profiles USING ((parent_id = auth.uid())) WITH CHECK ((parent_id = auth.uid()));

ALTER TABLE public.child_streaks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "child_streaks_select" ON public.child_streaks;
CREATE POLICY child_streaks_select ON public.child_streaks FOR SELECT USING ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

DROP POLICY IF EXISTS "child_streaks_upsert" ON public.child_streaks;
CREATE POLICY child_streaks_upsert ON public.child_streaks USING ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

ALTER TABLE public.daily_quests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "daily_quests_insert" ON public.daily_quests;
CREATE POLICY daily_quests_insert ON public.daily_quests FOR INSERT WITH CHECK ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "daily_quests_select" ON public.daily_quests;
CREATE POLICY daily_quests_select ON public.daily_quests FOR SELECT USING (true);

ALTER TABLE public.data_deletion_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.game_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.ip_rate_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ip_rate_limits: service_role only — locked" ON public.ip_rate_limits;
CREATE POLICY "ip_rate_limits: service_role only — locked" ON public.ip_rate_limits USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "parent reads own child sessions" ON public.game_sessions;
CREATE POLICY "parent reads own child sessions" ON public.game_sessions FOR SELECT USING ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

DROP POLICY IF EXISTS "parent reads quest sessions" ON public.quest_sessions;
CREATE POLICY "parent reads quest sessions" ON public.quest_sessions FOR SELECT USING ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

DROP POLICY IF EXISTS "parent reads word outcomes" ON public.word_outcomes;
CREATE POLICY "parent reads word outcomes" ON public.word_outcomes FOR SELECT USING ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

DROP POLICY IF EXISTS "parent_can_view_child_scan_attempts" ON public.scan_attempts;
CREATE POLICY parent_can_view_child_scan_attempts ON public.scan_attempts FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.child_profiles c
  WHERE ((c.id = scan_attempts.child_id) AND (c.parent_id = auth.uid())))));

DROP POLICY IF EXISTS "parent_insert_completions" ON public.quest_completions;
CREATE POLICY parent_insert_completions ON public.quest_completions FOR INSERT WITH CHECK ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

DROP POLICY IF EXISTS "parent_select_completions" ON public.quest_completions;
CREATE POLICY parent_select_completions ON public.quest_completions FOR SELECT USING ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

DROP POLICY IF EXISTS "parent_update_completions" ON public.quest_completions;
CREATE POLICY parent_update_completions ON public.quest_completions FOR UPDATE USING ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

ALTER TABLE public.parental_consents ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.parents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "parents: own row only" ON public.parents;
CREATE POLICY "parents: own row only" ON public.parents USING ((auth.uid() = id)) WITH CHECK ((auth.uid() = id));

ALTER TABLE public.privacy_policy_versions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.quest_completions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quest_completions: parent reads own" ON public.quest_completions;
CREATE POLICY "quest_completions: parent reads own" ON public.quest_completions FOR SELECT USING ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

ALTER TABLE public.quest_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.quests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quests: read rules" ON public.quests;
CREATE POLICY "quests: read rules" ON public.quests FOR SELECT USING (((is_active = true) AND ((created_by IS NULL) OR ((visibility = 'public'::text) AND (approved_at IS NOT NULL)) OR (created_by = auth.uid()))));

ALTER TABLE public.scan_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "scan_attempts: parent reads own children" ON public.scan_attempts;
CREATE POLICY "scan_attempts: parent reads own children" ON public.scan_attempts FOR SELECT USING ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

ALTER TABLE public.word_domains ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "word_domains_authenticated_read" ON public.word_domains;
CREATE POLICY word_domains_authenticated_read ON public.word_domains FOR SELECT TO authenticated USING (true);

ALTER TABLE public.word_outcomes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.word_tome ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "word_tome: parent reads own children" ON public.word_tome;
CREATE POLICY "word_tome: parent reads own children" ON public.word_tome FOR SELECT USING ((child_id IN ( SELECT child_profiles.id
   FROM public.child_profiles
  WHERE (child_profiles.parent_id = auth.uid()))));

-- ════════════════════════════════════════════════════════════════════════════
-- AUTH-SCHEMA TRIGGER — fires handle_new_user() on every auth signup
-- ════════════════════════════════════════════════════════════════════════════
-- pg_dump --schema=public didn't capture this trigger because it lives on
-- auth.users (auth schema). Without it, signups won't create the public.parents
-- row that child_profiles.parent_id FKs to, and the app will fail at
-- ChildSwitcherScreen → "create child" with a foreign-key violation.
--
-- Idempotent: drop-and-recreate.

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ════════════════════════════════════════════════════════════════════════════
-- GRANT EXECUTE — client-callable RPC functions
-- ════════════════════════════════════════════════════════════════════════════
-- pg_dump --no-privileges stripped these; they must be re-granted explicitly.
-- Without them, SECURITY DEFINER functions reject calls from the
-- `authenticated` role with "permission denied" before the function body runs.
--
-- Trigger functions (handle_new_user, sync_age_band, sync_tier_sort_order,
-- touch_updated_at, rls_auto_enable) don't need grants — they're invoked by
-- the trigger system, not directly by clients.
--
-- purge_scheduled_deletions runs as pg_cron (postgres role), no grant needed.
--
-- Two functions are deliberately NOT granted, matching staging:
--   • get_daily_scan_count — only called from the evaluate Edge Function via
--     service_role, never from the client
--   • approve_quest — admin RPC; admin dashboard uses service_role for the
--     RPC call, not the user's authenticated session. If a future client-side
--     admin UI invokes it as an authenticated user, add a grant then.

GRANT EXECUTE ON FUNCTION public.award_xp(uuid, integer)                                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin()                                                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_daily_completion(uuid, date)                        TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_word_learned(uuid, text, text, text)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.retire_word_and_promote(uuid, text, text, text)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_word_mastery(uuid, text, boolean)                   TO authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- SEED DATA — privacy_policy_versions (required for COPPA consent flow)
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO public.privacy_policy_versions (version, effective_date, summary_of_changes)
VALUES (
  '1.0',
  CURRENT_DATE,
  'Initial COPPA- and GDPR-K-compliant privacy policy.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- POST-RUN VERIFICATION
-- ════════════════════════════════════════════════════════════════════════════
--
-- Run these checks after the script completes:
--
--   -- 1. All 19 tables present:
--   SELECT count(*) FROM pg_tables WHERE schemaname = 'public';
--   -- expect 19
--
--   -- 2. All 7 views present:
--   SELECT count(*) FROM pg_views WHERE schemaname = 'public';
--   -- expect 7
--
--   -- 3. All 14 functions present:
--   SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace;
--   -- expect 14
--
--   -- 4. RPC EXECUTE grants (must be true for authenticated):
--   SELECT proname, has_function_privilege('authenticated', oid, 'EXECUTE') AS can_call
--     FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace
--      AND proname IN ('award_xp','record_word_learned','record_daily_completion',
--                      'update_word_mastery','retire_word_and_promote','is_admin');
--   -- all six should show can_call = true.
--   --
--   -- (get_daily_scan_count and approve_quest are intentionally NOT granted to
--   -- authenticated — they're called via service_role only. Matches staging.)
--
--   -- 5. Privacy policy seed:
--   SELECT version, effective_date FROM public.privacy_policy_versions;
--   -- expect at least one row with version = '1.0'
--
-- ════════════════════════════════════════════════════════════════════════════

