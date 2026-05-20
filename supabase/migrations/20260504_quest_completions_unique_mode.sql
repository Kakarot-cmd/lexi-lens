-- ============================================================================
-- 20260504_quest_completions_unique_mode.sql
-- Lexi-Lens — quest_completions: mode column + UNIQUE (child_id, quest_id, mode)
--
-- HISTORY: originally applied directly to live staging during the v3.5
-- quest-progress-persistence debugging pass; never committed to the repo
-- until 2026-05-20. Flagged in 3+ subsequent audits. Committing now to
-- close the gap so:
--   • bootstrap-then-migrate fresh provisioning matches the applied state
--   • a migration-replay-only fresh PROD has the same uniqueness guarantee
--     as live (without it, duplicate quest_completions corrupt streaks
--     and XP)
--
-- IDEMPOTENT BY COLUMN-TUPLE, NOT BY NAME — live staging + prod each carry
-- TWO UNIQUE (child_id, quest_id, mode) constraints (different system-
-- generated names: ..._key and ..._uniq, identical column tuple). A
-- name-based guard would silently add a third. We check the column tuple
-- and skip cleanly.
--
-- 2026-05-20 fix: pg_attribute.attname is type `name`, not `text`; the
-- equality comparison must cast or PostgreSQL throws 42883
-- (`operator does not exist: name[] = text[]`). Cast added inline in the
-- subquery.
--
-- REVERSIBILITY: fully additive. To revert, drop the named constraint
-- this migration creates (leaves the historical duplicates intact).
-- ============================================================================

-- ── 1. Ensure mode column exists ────────────────────────────────────────────
-- bootstrap.sql already defines mode with DEFAULT 'normal' and a CHECK.
-- A migration-only fresh provision needs this fallback.

ALTER TABLE public.quest_completions
    ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'normal';

-- ── 2. Ensure CHECK constraint on mode values ───────────────────────────────
-- Match bootstrap.sql exactly: only 'normal' or 'hard'.

DO $$
BEGIN
    BEGIN
        ALTER TABLE public.quest_completions
            ADD CONSTRAINT quest_completions_mode_check
            CHECK (mode = ANY (ARRAY['normal'::text, 'hard'::text]));
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;
END $$;

-- ── 3. Ensure UNIQUE (child_id, quest_id, mode) ─────────────────────────────
-- The reason for this entire file. Skip if ANY unique constraint already
-- covers exactly this column tuple, regardless of constraint name. This
-- handles the live state where the constraint exists twice already.

DO $$
DECLARE
    target_cols text[] := ARRAY['child_id', 'mode', 'quest_id'];  -- sorted
    existing record;
BEGIN
    FOR existing IN
        SELECT c.conname,
               (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
                  FROM unnest(c.conkey) AS k
                  JOIN pg_attribute a
                    ON a.attrelid = c.conrelid AND a.attnum = k) AS cols
          FROM pg_constraint c
         WHERE c.conrelid = 'public.quest_completions'::regclass
           AND c.contype = 'u'
    LOOP
        IF existing.cols = target_cols THEN
            RAISE NOTICE
              'quest_completions_unique_mode: constraint % already covers %; skipping ADD',
              existing.conname, target_cols;
            RETURN;
        END IF;
    END LOOP;

    ALTER TABLE public.quest_completions
        ADD CONSTRAINT quest_completions_child_quest_mode_unique
        UNIQUE (child_id, quest_id, mode);

    RAISE NOTICE 'quest_completions_unique_mode: added quest_completions_child_quest_mode_unique';
END $$;
