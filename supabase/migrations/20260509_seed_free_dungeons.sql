-- ============================================================================
-- 20260509_seed_free_dungeons.sql
-- Lexi-Lens — seed the three free-tier starter dungeons.
--
-- ─── What this migration does ──────────────────────────────────────────────
--
-- Inserts three apprentice-tier quests, marked min_subscription_tier='free',
-- with disjoint property pools designed for cache concentration:
--
--   ┌──────────────────────────┬─────────┬───────────────────────────────────┐
--   │ Dungeon                  │ Room    │ Pool                              │
--   ├──────────────────────────┼─────────┼───────────────────────────────────┤
--   │ Plushy Pixie's Bedroom   │ Bedroom │ A: soft, fluffy, smooth, stretchy │
--   │ Hollow Hippo's Kitchen   │ Kitchen │ B: round, hollow, cylindrical,    │
--   │                          │         │    curved                         │
--   │ Bookbound Banshee's Lib. │ Library │ C: flat, rectangular, rigid, thin │
--   └──────────────────────────┴─────────┴───────────────────────────────────┘
--
-- Pool A ∩ B = ∅, A ∩ C = ∅, B ∩ C = ∅. The prewarm corpus
-- (scripts/prewarm-corpus.ts v3) targets exactly these 12 unique words
-- against the highest-likelihood scan objects.
--
-- ─── Dependencies ─────────────────────────────────────────────────────────
--
-- This migration MUST apply AFTER 20260509_quest_subscription_tier.sql
-- (which adds the min_subscription_tier column). Migration ordering is
-- alphabetical by filename, and 'q' < 's' so this naturally lands in the
-- right order in supabase/migrations/.
--
-- ─── Idempotency ──────────────────────────────────────────────────────────
--
-- Uses ON CONFLICT (id) DO NOTHING with hardcoded UUIDs. Re-running the
-- migration is safe; existing rows are not modified. To re-seed (e.g.
-- after editing property definitions here), DELETE the rows first by id
-- then re-apply.
--
-- The hardcoded UUIDs are stable across staging and prod, simplifying
-- prewarm coordination — both envs reference the same dungeon IDs in
-- their cache_prewarm_seed rows.
--
-- ─── XP, sort order, tier ─────────────────────────────────────────────────
--
-- xp_reward 40/20/10 matches existing apprentice 5-6 quests (Snoozy Slime,
-- Bolt Beast). tier='apprentice', tier_sort_order=1. sort_order=1,2,3
-- places these as the first three entries within apprentice; this collides
-- with existing sort_order=1 (Boredom Behemoth's Study) but tied ordering
-- is broken by created_at and is harmless. Adjust the sort_order values
-- here if you want them strictly first or interleaved.
-- ============================================================================

BEGIN;

-- ─── DUNGEON 1: The Plushy Pixie's Bedroom (textures pool) ─────────────────

INSERT INTO public.quests (
  id,
  name, enemy_name, enemy_emoji, room_label, min_age_band,
  xp_reward_first_try, xp_reward_retry, xp_reward_third_plus,
  required_properties, hard_mode_properties, age_band_properties,
  tier, tier_sort_order, sort_order,
  spell_name, weapon_emoji, spell_description,
  is_active, visibility, created_by, target_child_id,
  approved_at, approved_by,
  min_subscription_tier
) VALUES (
  '11111111-aaaa-4ccc-8ddd-000000000001'::uuid,
  $$The Plushy Pixie's Bedroom$$,
  $$Plushy Pixie$$,
  $$🧚$$,
  $$Bedroom$$,
  $$5-6$$,
  40, 20, 10,
  $$[
    {"word":"soft","definition":"easy to press or squish — gives way when you push it","evaluationHints":"pillow, blanket, teddy bear, sock — squishes when you press it gently"},
    {"word":"fluffy","definition":"soft and full of light bits like feathers or fur","evaluationHints":"teddy bear, fluffy pillow, cushion, sweater — feels light and tickles your fingers"},
    {"word":"smooth","definition":"has no bumps or rough parts anywhere — feels completely even all over","evaluationHints":"smooth blanket, doll, scarf, pillowcase — finger glides without catching"}
  ]$$::jsonb,
  $$[
    {"word":"velvety","definition":"as soft and smooth as velvet — luxurious to the touch"},
    {"word":"downy","definition":"like duck feathers — extremely soft, fine and warm"},
    {"word":"plush","definition":"thick and luxurious like a plush carpet — both soft AND deep"}
  ]$$::jsonb,
  $${
    "5-6": [
      {"word":"soft","definition":"easy to press or squish — gives way when you push it"},
      {"word":"fluffy","definition":"soft and full of light bits like feathers or fur"},
      {"word":"smooth","definition":"has no bumps or rough parts anywhere — feels completely even all over"}
    ],
    "7-8": [
      {"word":"soft","definition":"yields under gentle pressure — compresses and rebounds easily"},
      {"word":"smooth","definition":"has no bumps, ridges, or rough patches across its surface"},
      {"word":"stretchy","definition":"can be pulled longer or wider and bounces back to its original shape"}
    ],
    "9-10": [
      {"word":"smooth","definition":"a uniformly even surface with no perceptible bumps or texture"},
      {"word":"stretchy","definition":"deforms elastically when pulled and returns precisely to its original shape"},
      {"word":"fluffy","definition":"composed of many soft fine fibres trapping air — light and voluminous"}
    ]
  }$$::jsonb,
  'apprentice', 1, 1,
  $$Plushy Surge Spell$$, $$🪄$$,
  $$A spell that calls forth the softest things to soothe the Plushy Pixie back to her dreams.$$,
  true, $$public$$, NULL, NULL,
  now(), NULL,
  $$free$$
)
ON CONFLICT (id) DO NOTHING;

-- ─── DUNGEON 2: The Hollow Hippo's Kitchen (shape-3D pool) ─────────────────

INSERT INTO public.quests (
  id,
  name, enemy_name, enemy_emoji, room_label, min_age_band,
  xp_reward_first_try, xp_reward_retry, xp_reward_third_plus,
  required_properties, hard_mode_properties, age_band_properties,
  tier, tier_sort_order, sort_order,
  spell_name, weapon_emoji, spell_description,
  is_active, visibility, created_by, target_child_id,
  approved_at, approved_by,
  min_subscription_tier
) VALUES (
  '22222222-aaaa-4ccc-8ddd-000000000002'::uuid,
  $$The Hollow Hippo's Kitchen$$,
  $$Hollow Hippo$$,
  $$🦛$$,
  $$Kitchen$$,
  $$5-6$$,
  40, 20, 10,
  $$[
    {"word":"round","definition":"shaped like a circle or a ball — same width all the way around","evaluationHints":"ball, apple, cup top, bowl rim, plate — no corners anywhere on the outline"},
    {"word":"hollow","definition":"empty inside — has open space with nothing filling it","evaluationHints":"cup, mug, bowl, bottle, jar — you can pour something INTO it"},
    {"word":"curved","definition":"bending like a smile or a bowl — not flat or straight","evaluationHints":"bowl edge, banana, cup side, balloon — follow the line and it gently bends"}
  ]$$::jsonb,
  $$[
    {"word":"spherical","definition":"perfectly round in all directions — like a true ball or globe"},
    {"word":"conical","definition":"shaped like a cone — wide at one end, pointy at the other"},
    {"word":"domed","definition":"with a rounded top like an upside-down bowl"}
  ]$$::jsonb,
  $${
    "5-6": [
      {"word":"round","definition":"shaped like a circle or a ball — same width all the way around"},
      {"word":"hollow","definition":"empty inside — has open space with nothing filling it"},
      {"word":"curved","definition":"bending like a smile or a bowl — not flat or straight"}
    ],
    "7-8": [
      {"word":"round","definition":"circular when viewed from any side — uniformly bounded by curves"},
      {"word":"hollow","definition":"has an empty interior cavity — designed to contain something"},
      {"word":"cylindrical","definition":"shaped like a tube or can — round all the way around and the same width top-to-bottom"}
    ],
    "9-10": [
      {"word":"cylindrical","definition":"a 3-D shape with two parallel circular ends connected by a curved surface — like a tin can or pipe"},
      {"word":"hollow","definition":"contains an interior void — interior empty rather than filled"},
      {"word":"curved","definition":"surface or edge follows a continuous bend rather than a straight line"}
    ]
  }$$::jsonb,
  'apprentice', 1, 2,
  $$Hollow Hum Spell$$, $$🪄$$,
  $$A spell that finds round, hollow vessels to fill the Hollow Hippo's belly.$$,
  true, $$public$$, NULL, NULL,
  now(), NULL,
  $$free$$
)
ON CONFLICT (id) DO NOTHING;

-- ─── DUNGEON 3: The Bookbound Banshee's Library (flatness pool) ────────────

INSERT INTO public.quests (
  id,
  name, enemy_name, enemy_emoji, room_label, min_age_band,
  xp_reward_first_try, xp_reward_retry, xp_reward_third_plus,
  required_properties, hard_mode_properties, age_band_properties,
  tier, tier_sort_order, sort_order,
  spell_name, weapon_emoji, spell_description,
  is_active, visibility, created_by, target_child_id,
  approved_at, approved_by,
  min_subscription_tier
) VALUES (
  '33333333-aaaa-4ccc-8ddd-000000000003'::uuid,
  $$The Bookbound Banshee's Library$$,
  $$Bookbound Banshee$$,
  $$👻$$,
  $$Library$$,
  $$5-6$$,
  40, 20, 10,
  $$[
    {"word":"flat","definition":"completely level — no bumps or curves up or down","evaluationHints":"book cover, paper, plate top, ruler — put it on a table and it lies still"},
    {"word":"thin","definition":"not thick — small distance between front and back","evaluationHints":"paper, magazine, ruler, card — thinner than your finger"},
    {"word":"rectangular","definition":"shaped like a box-rectangle — four flat sides with corners, longer than it is wide","evaluationHints":"book, notebook, paper, tablet — has four corners and isn't square"}
  ]$$::jsonb,
  $$[
    {"word":"planar","definition":"having a single flat plane as its surface — geometrically two-dimensional"},
    {"word":"laminated","definition":"made of multiple thin layers bonded together — more rigid than any single layer"},
    {"word":"stratified","definition":"arranged in distinct horizontal layers — like a stack of pages"}
  ]$$::jsonb,
  $${
    "5-6": [
      {"word":"flat","definition":"completely level — no bumps or curves up or down"},
      {"word":"thin","definition":"not thick — small distance between front and back"},
      {"word":"rectangular","definition":"shaped like a box-rectangle — four flat sides with corners, longer than it is wide"}
    ],
    "7-8": [
      {"word":"flat","definition":"has a level surface with no significant bumps or warps"},
      {"word":"rectangular","definition":"has four straight sides meeting at right angles — longer in one direction than the other"},
      {"word":"rigid","definition":"completely stiff — does not bend at all when pressed firmly"}
    ],
    "9-10": [
      {"word":"rigid","definition":"resists deformation entirely — cannot be flexed or bent without breaking"},
      {"word":"rectangular","definition":"a quadrilateral with four right angles and unequal adjacent sides"},
      {"word":"thin","definition":"has a small thickness relative to its length and width — barely deep at all"}
    ]
  }$$::jsonb,
  'apprentice', 1, 3,
  $$Page Pulse Spell$$, $$🪄$$,
  $$A spell that lays flat objects to silence the Bookbound Banshee's wail.$$,
  true, $$public$$, NULL, NULL,
  now(), NULL,
  $$free$$
)
ON CONFLICT (id) DO NOTHING;

-- ─── Verification ──────────────────────────────────────────────────────────
--
-- Expect 3 rows:
--   SELECT id, name, room_label, min_subscription_tier, tier, sort_order
--   FROM public.quests
--   WHERE min_subscription_tier = 'free'
--   ORDER BY sort_order;
--
-- Expected output:
--   id                                       | name                              | room_label | min_subscription_tier | tier        | sort_order
--   11111111-aaaa-4ccc-8ddd-000000000001     | The Plushy Pixie's Bedroom        | Bedroom    | free                  | apprentice  | 1
--   22222222-aaaa-4ccc-8ddd-000000000002     | The Hollow Hippo's Kitchen        | Kitchen    | free                  | apprentice  | 2
--   33333333-aaaa-4ccc-8ddd-000000000003     | The Bookbound Banshee's Library   | Library    | free                  | apprentice  | 3
--
-- Sanity-check pool disjointness (should return 0 rows):
--   WITH all_words AS (
--     SELECT q.name, jsonb_array_elements(props) ->> 'word' AS word
--     FROM public.quests q,
--          jsonb_each(q.age_band_properties) AS bands(age_band, props)
--     WHERE q.id IN (
--       '11111111-aaaa-4ccc-8ddd-000000000001'::uuid,
--       '22222222-aaaa-4ccc-8ddd-000000000002'::uuid,
--       '33333333-aaaa-4ccc-8ddd-000000000003'::uuid
--     )
--   )
--   SELECT word, count(DISTINCT name) AS dungeon_count
--   FROM all_words
--   GROUP BY word
--   HAVING count(DISTINCT name) > 1;
--   -- Expected: 0 rows (no word appears in more than one dungeon).

COMMIT;
