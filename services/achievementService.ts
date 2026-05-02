/**
 * services/achievementService.ts
 * Lexi-Lens — N4: Achievement Badge System
 *
 * Pure data layer. No React, no hooks, no side effects beyond the DB write.
 * Called from gameStore.checkAndAwardBadges() after any game event.
 *
 * ── 16 Badges across 6 categories ────────────────────────────────────────────
 *   first-time  — first scan, first quest, first word
 *   streak      — 3d, 7d, 30d streak
 *   word-tome   — 10, 25, 50 words learned
 *   xp          — 500, 2000 XP earned
 *   tier        — Scholar, Sage, Archmage quest cleared
 *   hard-mode   — 1st and 5th Hard Mode victory
 *
 * ── DB ────────────────────────────────────────────────────────────────────────
 *   Table: child_achievements (child_id, badge_id, earned_at)
 *   Migration: supabase/migrations/20260502_achievements.sql
 */

import { supabase } from "../lib/supabase";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BadgeRarity   = "common" | "rare" | "epic" | "legendary";
export type BadgeCategory = "first-time" | "streak" | "word-tome" | "xp" | "tier" | "hard-mode";

export interface Badge {
  id:          string;
  emoji:       string;
  name:        string;
  description: string;
  rarity:      BadgeRarity;
  category:    BadgeCategory;
}

export interface AchievementRecord {
  badge_id:  string;
  earned_at: string;
}

export interface BadgeCheckContext {
  childId:           string;
  totalXp:           number;
  wordCount:         number;          // wordTomeCache.length
  streak:            number;          // streak.currentStreak
  completedQuestIds: string[];
  hardCompletedIds:  string[];
  completedTiers:    string[];        // e.g. ["apprentice","scholar"]  ← from spellBook[].tier
  hasScanned:        boolean;         // proxy: wordCount>0 || completedQuestIds.length>0
}

// ── Badge Registry ────────────────────────────────────────────────────────────

export const BADGE_DEFINITIONS: Badge[] = [
  // ── First-time ─────────────────────────────────────────────────────────────
  {
    id:          "first_scan",
    emoji:       "🔮",
    name:        "First Spell Cast",
    description: "Cast your very first magic scan",
    rarity:      "common",
    category:    "first-time",
  },
  {
    id:          "first_quest",
    emoji:       "⚔️",
    name:        "Dungeon Breaker",
    description: "Completed your very first quest",
    rarity:      "common",
    category:    "first-time",
  },
  {
    id:          "first_word",
    emoji:       "📖",
    name:        "Word Seeker",
    description: "First word added to your Word Tome",
    rarity:      "common",
    category:    "first-time",
  },

  // ── Streak ─────────────────────────────────────────────────────────────────
  {
    id:          "streak_3",
    emoji:       "🔥",
    name:        "Flame Starter",
    description: "3 days in a row — you're on fire!",
    rarity:      "common",
    category:    "streak",
  },
  {
    id:          "streak_7",
    emoji:       "🌋",
    name:        "Week Warrior",
    description: "7-day streak — 2× XP now active!",
    rarity:      "rare",
    category:    "streak",
  },
  {
    id:          "streak_30",
    emoji:       "☄️",
    name:        "Unstoppable",
    description: "30 straight days of questing — legendary!",
    rarity:      "legendary",
    category:    "streak",
  },

  // ── Word Tome ──────────────────────────────────────────────────────────────
  {
    id:          "words_10",
    emoji:       "📚",
    name:        "Word Collector",
    description: "10 words learned in your Tome",
    rarity:      "common",
    category:    "word-tome",
  },
  {
    id:          "words_25",
    emoji:       "🗂️",
    name:        "Tome Scholar",
    description: "25 words mastered — impressive!",
    rarity:      "rare",
    category:    "word-tome",
  },
  {
    id:          "words_50",
    emoji:       "🏛️",
    name:        "Grand Librarian",
    description: "50 words — true Word Master!",
    rarity:      "epic",
    category:    "word-tome",
  },

  // ── XP ─────────────────────────────────────────────────────────────────────
  {
    id:          "xp_500",
    emoji:       "⚡",
    name:        "Power Surge",
    description: "500 XP earned in battle",
    rarity:      "common",
    category:    "xp",
  },
  {
    id:          "xp_2000",
    emoji:       "💎",
    name:        "XP Legend",
    description: "2000 XP — unstoppable power!",
    rarity:      "epic",
    category:    "xp",
  },

  // ── Tier ───────────────────────────────────────────────────────────────────
  {
    id:          "tier_scholar",
    emoji:       "📜",
    name:        "Scholar Slayer",
    description: "Defeated a Scholar tier enemy",
    rarity:      "rare",
    category:    "tier",
  },
  {
    id:          "tier_sage",
    emoji:       "🔮",
    name:        "Sage Vanquisher",
    description: "Defeated a Sage tier enemy",
    rarity:      "epic",
    category:    "tier",
  },
  {
    id:          "tier_archmage",
    emoji:       "🌌",
    name:        "Archmage Slayer",
    description: "Conquered the mightiest dungeon!",
    rarity:      "legendary",
    category:    "tier",
  },

  // ── Hard Mode ──────────────────────────────────────────────────────────────
  {
    id:          "hard_first",
    emoji:       "💀",
    name:        "Hard Breaker",
    description: "Won your first Hard Mode quest",
    rarity:      "rare",
    category:    "hard-mode",
  },
  {
    id:          "hard_five",
    emoji:       "👑",
    name:        "Iron Will",
    description: "5 Hard Mode victories — legendary!",
    rarity:      "legendary",
    category:    "hard-mode",
  },
];

/** O(1) lookup by badge ID */
export const BADGE_MAP = new Map<string, Badge>(
  BADGE_DEFINITIONS.map((b) => [b.id, b])
);

// ── Rarity styling tokens ─────────────────────────────────────────────────────

export const RARITY_COLOR: Record<BadgeRarity, string> = {
  common:    "#6b7280",
  rare:      "#3b82f6",
  epic:      "#7c3aed",
  legendary: "#f59e0b",
};

export const RARITY_GLOW: Record<BadgeRarity, string> = {
  common:    "rgba(107,114,128,0.25)",
  rare:      "rgba(59,130,246,0.35)",
  epic:      "rgba(124,58,237,0.40)",
  legendary: "rgba(245,158,11,0.50)",
};

export const RARITY_BG: Record<BadgeRarity, string> = {
  common:    "rgba(107,114,128,0.12)",
  rare:      "rgba(59,130,246,0.12)",
  epic:      "rgba(124,58,237,0.14)",
  legendary: "rgba(245,158,11,0.15)",
};

export const RARITY_LABEL: Record<BadgeRarity, string> = {
  common:    "Common",
  rare:      "Rare",
  epic:      "Epic",
  legendary: "Legendary ✨",
};

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * Load all earned badge records for a child.
 * Called from gameStore.checkAndAwardBadges() — always fresh from DB
 * to prevent double-awarding across sessions.
 */
export async function loadEarnedAchievements(
  childId: string
): Promise<AchievementRecord[]> {
  const { data, error } = await supabase
    .from("child_achievements")
    .select("badge_id, earned_at")
    .eq("child_id", childId)
    .order("earned_at", { ascending: true });

  if (error) {
    console.warn("[achievementService] loadEarned failed:", error.message);
    return [];
  }
  return data ?? [];
}

// ── Core badge check ──────────────────────────────────────────────────────────

/**
 * Check which new badges are earned given current game state.
 * Persists newly earned badges to DB.
 * Returns the Badge objects that were newly awarded (for toast + notification).
 *
 * @param ctx     — current game state snapshot (from gameStore)
 * @param earned  — already-earned badges from DB (pass fresh from loadEarned)
 */
export async function checkAndAward(
  ctx:    BadgeCheckContext,
  earned: AchievementRecord[]
): Promise<Badge[]> {
  const earnedSet = new Set(earned.map((e) => e.badge_id));
  const candidates: string[] = [];

  // ── First-time ─────────────────────────────────────────────────────────────
  if (!earnedSet.has("first_scan")  && ctx.hasScanned)
    candidates.push("first_scan");
  if (!earnedSet.has("first_quest") && ctx.completedQuestIds.length >= 1)
    candidates.push("first_quest");
  if (!earnedSet.has("first_word")  && ctx.wordCount >= 1)
    candidates.push("first_word");

  // ── Streak ─────────────────────────────────────────────────────────────────
  if (!earnedSet.has("streak_3")  && ctx.streak >= 3)
    candidates.push("streak_3");
  if (!earnedSet.has("streak_7")  && ctx.streak >= 7)
    candidates.push("streak_7");
  if (!earnedSet.has("streak_30") && ctx.streak >= 30)
    candidates.push("streak_30");

  // ── Word Tome ──────────────────────────────────────────────────────────────
  if (!earnedSet.has("words_10") && ctx.wordCount >= 10)
    candidates.push("words_10");
  if (!earnedSet.has("words_25") && ctx.wordCount >= 25)
    candidates.push("words_25");
  if (!earnedSet.has("words_50") && ctx.wordCount >= 50)
    candidates.push("words_50");

  // ── XP ─────────────────────────────────────────────────────────────────────
  if (!earnedSet.has("xp_500")  && ctx.totalXp >= 500)
    candidates.push("xp_500");
  if (!earnedSet.has("xp_2000") && ctx.totalXp >= 2000)
    candidates.push("xp_2000");

  // ── Tier ───────────────────────────────────────────────────────────────────
  const tiers = new Set(ctx.completedTiers.map((t) => t.toLowerCase()));
  if (!earnedSet.has("tier_scholar")  && tiers.has("scholar"))
    candidates.push("tier_scholar");
  if (!earnedSet.has("tier_sage")     && tiers.has("sage"))
    candidates.push("tier_sage");
  if (!earnedSet.has("tier_archmage") && tiers.has("archmage"))
    candidates.push("tier_archmage");

  // ── Hard Mode ──────────────────────────────────────────────────────────────
  if (!earnedSet.has("hard_first") && ctx.hardCompletedIds.length >= 1)
    candidates.push("hard_first");
  if (!earnedSet.has("hard_five")  && ctx.hardCompletedIds.length >= 5)
    candidates.push("hard_five");

  if (candidates.length === 0) return [];

  // ── Persist ────────────────────────────────────────────────────────────────
  const now = new Date().toISOString();
  const { error: insertErr } = await supabase
    .from("child_achievements")
    .insert(
      candidates.map((badge_id) => ({
        child_id:  ctx.childId,
        badge_id,
        earned_at: now,
      }))
    );

  if (insertErr) {
    // unique constraint violation = badge already exists (race condition guard)
    // silently return empty to avoid duplicate toasts
    console.warn("[achievementService] insert failed:", insertErr.message);
    return [];
  }

  return candidates
    .map((id) => BADGE_MAP.get(id))
    .filter((b): b is Badge => b !== undefined);
}
