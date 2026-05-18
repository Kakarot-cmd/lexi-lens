-- ============================================================================
-- 20260518_model_provider_flags_app_logic.sql
-- Lexi-Lens — seed model-provider flags for the app-logic AI functions that
-- were just wired to the _shared/models factory.
--
-- WHY THIS MIGRATION IS MANDATORY, NOT OPTIONAL
-- ─────────────────────────────────────────────
-- The factory resolution order is:  feature_flags → env var → hardcoded
-- default. The hardcoded default in _shared/models/index.ts is **'mistral'**.
--
-- classify-words and retire-word were just changed from a hardcoded raw
-- Haiku fetch to getModelAdapter(). With NO flag row seeded, they would
-- silently resolve to **Mistral**, not Gemini. The whole point of making
-- them dynamic was the ~30x Haiku→Gemini cost cut on uncapped,
-- free-user-reachable functions — so the target provider must be pinned
-- explicitly here. Shipping the function change without this migration
-- = "we meant Gemini, we got Mistral" by accident.
--
-- DECISION (recorded)
-- ───────────────────
--   classify-words  → gemini   : 6-domain bucketing is a trivial text task.
--                                Uncapped + every parent (free included)
--                                triggers it via the Mastery Radar. Gemini
--                                Flash-Lite ≈ 30x cheaper than Haiku, zero
--                                quality risk. This is the cost fix.
--   retire-word     → gemini   : "suggest one harder synonym + child
--                                definition" — trivial. Fires once per word
--                                a child genuinely masters (>=0.80). Same
--                                reasoning.
--   generate-quest  → (unchanged, anthropic) : NOT touched here. Quest text
--                                is user-facing; a model regression is
--                                visible. Holds at Haiku pending a quality
--                                A/B. ensure-daily-quest now uses the
--                                generate-quest scope/flag, so it inherits
--                                this (correct: daily quest is also
--                                user-facing content, ~1 call/day globally,
--                                no cost reason to move it).
--
-- WHY NOT CAP THESE INSTEAD (the unbiased counter-take)
-- ─────────────────────────────────────────────────────
-- classify-words is globally + permanently cached (word_domains PK = word,
-- shared across ALL users/children, "once classified always classified").
-- Cost decays toward zero as the finite kids-vocabulary corpus saturates.
-- retire-word is idempotent per word and progression-gated (fires once when
-- mastery crosses 0.80, not per scan). Neither can be cheaply inflated by a
-- user. So the blow-up risk is real in DIRECTION but modest in MAGNITUDE —
-- and a cap would silently break the learning loop (no synonym promotion;
-- permanently incomplete Mastery Radar) to save pennies. Cheapen, don't cap.
-- This migration is the correct lever; no usage cap is added for these two.
--
-- REVERSIBILITY
-- ─────────────
-- Pure feature_flags rows. To revert to Haiku without a redeploy:
--   UPDATE public.feature_flags SET value='anthropic'
--    WHERE key IN ('classify_words_model_provider','retire_word_model_provider');
-- ON CONFLICT DO NOTHING — re-running never clobbers a value you have since
-- tuned by hand.
--
-- VERIFY AFTER APPLY (staging then prod)
--   SELECT key, value FROM public.feature_flags
--    WHERE key LIKE '%_model_provider' ORDER BY key;
--   -- expect classify_words=gemini, retire_word=gemini,
--   --        evaluate/generate_quest/etc unchanged.
-- ============================================================================

BEGIN;

INSERT INTO public.feature_flags (key, value, description) VALUES
  ('classify_words_model_provider', 'gemini',
   'Provider for classify-words (anthropic|gemini|mistral). gemini: trivial '
   '6-domain bucketing, uncapped + free-user-reachable via Mastery Radar, '
   '~30x cheaper than Haiku, zero quality risk. The cost fix for this scope.'),
  ('retire_word_model_provider', 'gemini',
   'Provider for retire-word (anthropic|gemini|mistral). gemini: trivial '
   'synonym suggestion, fires once per mastered word, ~30x cheaper than '
   'Haiku, zero quality risk.')
ON CONFLICT (key) DO NOTHING;

-- generate_quest_model_provider is intentionally NOT seeded here. If it does
-- not already exist from the earlier gating migration, the factory default
-- chain applies. If you want ensure-daily-quest / generate-quest pinned to
-- Haiku explicitly (recommended until the quest-quality A/B), uncomment:
--
-- INSERT INTO public.feature_flags (key, value, description) VALUES
--   ('generate_quest_model_provider', 'anthropic',
--    'Provider for generate-quest + ensure-daily-quest. Holds at anthropic '
--    '(Haiku) — quest text is user-facing; flip to gemini only after a '
--    'quest-quality A/B.')
-- ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.feature_flags
   WHERE key IN ('classify_words_model_provider','retire_word_model_provider')
     AND value = 'gemini';
  RAISE NOTICE 'app-logic model-provider seed: %/2 flags = gemini', n;
END $$;

COMMIT;
