-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.admin_audit_log (
  id bigint NOT NULL DEFAULT nextval('admin_audit_log_id_seq'::regclass),
  admin_id uuid NOT NULL,
  action text NOT NULL,
  target_id uuid,
  payload jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT admin_audit_log_pkey PRIMARY KEY (id),
  CONSTRAINT admin_audit_log_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES auth.users(id)
);
CREATE TABLE public.admin_users (
  id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT admin_users_pkey PRIMARY KEY (id),
  CONSTRAINT admin_users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id)
);
CREATE TABLE public.child_achievements (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  child_id uuid NOT NULL,
  badge_id text NOT NULL,
  earned_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT child_achievements_pkey PRIMARY KEY (id),
  CONSTRAINT child_achievements_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.child_profiles(id)
);
CREATE TABLE public.child_profiles (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  parent_id uuid NOT NULL,
  display_name text NOT NULL CHECK (char_length(display_name) <= 30),
  age_band text NOT NULL CHECK (age_band = ANY (ARRAY['5-6'::text, '7-8'::text, '9-10'::text, '11-12'::text])),
  avatar_key text,
  level integer NOT NULL DEFAULT 1 CHECK (level >= 1 AND level <= 100),
  total_xp integer NOT NULL DEFAULT 0 CHECK (total_xp >= 0),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  age integer NOT NULL DEFAULT 8 CHECK (age >= 5 AND age <= 12),
  CONSTRAINT child_profiles_pkey PRIMARY KEY (id),
  CONSTRAINT child_profiles_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parents(id)
);
CREATE TABLE public.child_streaks (
  child_id uuid NOT NULL,
  current_streak integer NOT NULL DEFAULT 0,
  longest_streak integer NOT NULL DEFAULT 0,
  last_quest_date date,
  streak_dates ARRAY NOT NULL DEFAULT '{}'::date[],
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT child_streaks_pkey PRIMARY KEY (child_id),
  CONSTRAINT child_streaks_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.child_profiles(id)
);
CREATE TABLE public.daily_quests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  quest_date date NOT NULL UNIQUE,
  quest_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT daily_quests_pkey PRIMARY KEY (id),
  CONSTRAINT daily_quests_quest_id_fkey FOREIGN KEY (quest_id) REFERENCES public.quests(id)
);
CREATE TABLE public.data_deletion_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  parent_id uuid,
  requested_at timestamp with time zone NOT NULL DEFAULT now(),
  scheduled_deletion_at timestamp with time zone,
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'cancelled'::text])),
  reason text,
  completed_at timestamp with time zone,
  children_deleted integer,
  scan_rows_deleted integer,
  mastery_rows_deleted integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT data_deletion_requests_pkey PRIMARY KEY (id),
  CONSTRAINT data_deletion_requests_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES auth.users(id)
);
CREATE TABLE public.game_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  child_id uuid NOT NULL,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  ended_at timestamp with time zone,
  duration_sec integer DEFAULT (EXTRACT(epoch FROM (ended_at - started_at)))::integer,
  screen_sequence ARRAY,
  quests_started integer NOT NULL DEFAULT 0,
  quests_finished integer NOT NULL DEFAULT 0,
  xp_earned integer NOT NULL DEFAULT 0,
  CONSTRAINT game_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT game_sessions_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.child_profiles(id)
);
CREATE TABLE public.ip_rate_limits (
  ip_hash text NOT NULL,
  request_count integer NOT NULL DEFAULT 1,
  window_start timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT ip_rate_limits_pkey PRIMARY KEY (ip_hash)
);
CREATE TABLE public.parental_consents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  parent_id uuid NOT NULL,
  policy_version text NOT NULL,
  consented_at timestamp with time zone NOT NULL,
  coppa_confirmed boolean NOT NULL DEFAULT false,
  gdpr_k_confirmed boolean NOT NULL DEFAULT false,
  ai_processing_confirmed boolean NOT NULL DEFAULT false,
  parental_gate_passed boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT parental_consents_pkey PRIMARY KEY (id),
  CONSTRAINT parental_consents_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES auth.users(id)
);
CREATE TABLE public.parents (
  id uuid NOT NULL,
  display_name text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT parents_pkey PRIMARY KEY (id),
  CONSTRAINT parents_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id)
);
CREATE TABLE public.privacy_policy_versions (
  version text NOT NULL,
  effective_date date NOT NULL,
  summary_of_changes text NOT NULL DEFAULT ''::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT privacy_policy_versions_pkey PRIMARY KEY (version)
);
CREATE TABLE public.quest_completions (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  child_id uuid NOT NULL,
  quest_id uuid NOT NULL,
  total_xp integer NOT NULL,
  attempt_count integer NOT NULL DEFAULT 1,
  completed_at timestamp with time zone NOT NULL DEFAULT now(),
  mode text NOT NULL DEFAULT 'normal'::text CHECK (mode = ANY (ARRAY['normal'::text, 'hard'::text])),
  CONSTRAINT quest_completions_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.child_profiles(id),
  CONSTRAINT quest_completions_quest_id_fkey FOREIGN KEY (quest_id) REFERENCES public.quests(id)
);
CREATE TABLE public.quest_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  child_id uuid NOT NULL,
  quest_id uuid NOT NULL,
  game_session_id uuid,
  hard_mode boolean NOT NULL DEFAULT false,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  finished_at timestamp with time zone,
  completed boolean NOT NULL DEFAULT false,
  total_scans integer NOT NULL DEFAULT 0,
  xp_awarded integer NOT NULL DEFAULT 0,
  CONSTRAINT quest_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT quest_sessions_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.child_profiles(id),
  CONSTRAINT quest_sessions_quest_id_fkey FOREIGN KEY (quest_id) REFERENCES public.quests(id),
  CONSTRAINT quest_sessions_game_session_id_fkey FOREIGN KEY (game_session_id) REFERENCES public.game_sessions(id)
);
CREATE TABLE public.quests (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  enemy_name text NOT NULL,
  enemy_emoji text NOT NULL,
  room_label text NOT NULL,
  min_age_band text NOT NULL CHECK (min_age_band = ANY (ARRAY['5-6'::text, '7-8'::text, '9-10'::text, '11-12'::text, '13-14'::text])),
  xp_reward_first_try integer NOT NULL DEFAULT 40,
  xp_reward_retry integer NOT NULL DEFAULT 20,
  required_properties jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  hard_mode_properties jsonb NOT NULL DEFAULT '[]'::jsonb,
  tier USER-DEFINED NOT NULL DEFAULT 'apprentice'::quest_tier CHECK (tier = ANY (ARRAY['apprentice'::quest_tier, 'scholar'::quest_tier, 'sage'::quest_tier, 'archmage'::quest_tier])),
  tier_sort_order integer NOT NULL DEFAULT 1,
  age_band_properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  visibility text NOT NULL DEFAULT 'public'::text CHECK (visibility = ANY (ARRAY['public'::text, 'private'::text, 'pending_approval'::text])),
  approved_at timestamp with time zone,
  approved_by uuid,
  sort_order integer NOT NULL DEFAULT 8,
  spell_name text,
  weapon_emoji text,
  spell_description text,
  target_child_id uuid,
  xp_reward_third_plus integer NOT NULL DEFAULT 10,
  CONSTRAINT quests_pkey PRIMARY KEY (id),
  CONSTRAINT quests_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id),
  CONSTRAINT quests_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id),
  CONSTRAINT quests_target_child_id_fkey FOREIGN KEY (target_child_id) REFERENCES public.child_profiles(id)
);
CREATE TABLE public.scan_attempts (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  child_id uuid NOT NULL,
  quest_id uuid NOT NULL,
  detected_label text NOT NULL,
  vision_confidence numeric NOT NULL CHECK (vision_confidence >= 0::numeric AND vision_confidence <= 1::numeric),
  resolved_name text NOT NULL,
  overall_match boolean NOT NULL,
  property_scores jsonb NOT NULL,
  child_feedback text NOT NULL,
  xp_awarded integer NOT NULL DEFAULT 0 CHECK (xp_awarded >= 0),
  vision_latency_ms integer,
  claude_latency_ms integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  ip_hash text,
  rate_limited boolean NOT NULL DEFAULT false,
  CONSTRAINT scan_attempts_pkey PRIMARY KEY (id),
  CONSTRAINT scan_attempts_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.child_profiles(id),
  CONSTRAINT scan_attempts_quest_id_fkey FOREIGN KEY (quest_id) REFERENCES public.quests(id)
);
CREATE TABLE public.word_domains (
  word text NOT NULL CHECK (word = lower(word)),
  domain text NOT NULL CHECK (domain = ANY (ARRAY['texture'::text, 'colour'::text, 'structure'::text, 'sound'::text, 'shape'::text, 'material'::text, 'other'::text])),
  confidence text CHECK (confidence IS NULL OR (confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text]))),
  classified_at timestamp with time zone NOT NULL DEFAULT now(),
  classified_by text DEFAULT 'claude-haiku-4-5-20251001'::text,
  CONSTRAINT word_domains_pkey PRIMARY KEY (word)
);
CREATE TABLE public.word_outcomes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  child_id uuid NOT NULL,
  quest_id uuid,
  word text NOT NULL,
  passed boolean NOT NULL,
  scan_label text,
  attempt_num integer NOT NULL DEFAULT 1,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT word_outcomes_pkey PRIMARY KEY (id),
  CONSTRAINT word_outcomes_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.child_profiles(id),
  CONSTRAINT word_outcomes_quest_id_fkey FOREIGN KEY (quest_id) REFERENCES public.quests(id)
);
CREATE TABLE public.word_tome (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  child_id uuid NOT NULL,
  word text NOT NULL,
  definition text NOT NULL,
  exemplar_object text NOT NULL,
  times_used integer NOT NULL DEFAULT 1 CHECK (times_used >= 1),
  first_used_at timestamp with time zone NOT NULL DEFAULT now(),
  last_used_at timestamp with time zone NOT NULL DEFAULT now(),
  mastery_score double precision NOT NULL DEFAULT 0.0 CHECK (mastery_score >= 0.0::double precision AND mastery_score <= 1.0::double precision),
  mastery_updated_at timestamp with time zone,
  is_retired boolean NOT NULL DEFAULT false,
  retired_synonym text,
  retired_synonym_def text,
  CONSTRAINT word_tome_pkey PRIMARY KEY (id),
  CONSTRAINT word_tome_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.child_profiles(id)
);