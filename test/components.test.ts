/**
 * components.test.ts
 * Chunk 7 — Other components (pure logic only, no rendering)
 *
 * Coverage:
 *   1. VerdictCard.splitProperties     — defensive ?. against malformed result
 *   2. VerdictCard.bonusPillText       — 1.5×/2× thresholds
 *   3. VerdictCard.stripAutoCorrectedTag — the regex strip
 *   4. VerdictCard.headerTitle         — singular/plural + Almost…
 *   5. RateLimitWall.secondsUntil      — null guard, never-negative
 *   6. RateLimitWall.formatCountdown   — HH:MM:SS padding
 *   7. RateLimitWall.approachingLimitMath
 *   8. StreakHeatmap.isoOffset         — YYYY-MM-DD shape
 *   9. StreakHeatmap.last28Days        — length, ordering
 *  10. StreakHeatmap.padDaysToWeeks    — Sunday alignment, week shape
 *  11. StreakBar.flameOpacities        — lit count
 *  12. StreakBar.progressHintText      — singular/plural + threshold off
 *  13. DailyQuestBanner.computeMaxXpFirst
 *  14. DailyQuestBanner.dailyXpDisplay
 *  15. RecentSessionsPanel.formatRelative — Today/Yesterday/weekday
 *  16. RecentSessionsPanel.formatDuration — s/m/h ladder
 */

import {
  splitProperties,
  bonusPillText,
  stripAutoCorrectedTag,
  headerTitle,
  secondsUntil,
  formatCountdown,
  approachingLimitMath,
  isoOffset,
  last28Days,
  padDaysToWeeks,
  DAY_LABELS,
  flameOpacities,
  progressHintText,
  computeMaxXpFirst,
  dailyXpDisplay,
  formatRelative,
  formatDuration,
} from "./components";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. VerdictCard.splitProperties
// ═══════════════════════════════════════════════════════════════════════════════

describe("VerdictCard.splitProperties — defensive against malformed results", () => {
  test("null result → empty arrays, somethingFound=false, totalXpEarned=0", () => {
    const r = splitProperties(null);
    expect(r.passingProps).toEqual([]);
    expect(r.failingProps).toEqual([]);
    expect(r.somethingFound).toBe(false);
    expect(r.totalXpEarned).toBe(0);
  });

  test("undefined result → empty arrays", () => {
    const r = splitProperties(undefined);
    expect(r.passingProps).toEqual([]);
    expect(r.failingProps).toEqual([]);
  });

  test("result with no properties field → empty arrays (no crash)", () => {
    const r = splitProperties({ resolvedObjectName: "x", xpAwarded: 0 });
    expect(r.passingProps).toEqual([]);
    expect(r.failingProps).toEqual([]);
  });

  test("splits passing and failing correctly", () => {
    const r = splitProperties({
      properties: [
        { word: "a", score: 0.9, reasoning: "x", passes: true },
        { word: "b", score: 0.4, reasoning: "x", passes: false },
        { word: "c", score: 0.8, reasoning: "x", passes: true },
      ],
      xpAwarded: 240,
    });
    expect(r.passingProps).toHaveLength(2);
    expect(r.failingProps).toHaveLength(1);
    expect(r.somethingFound).toBe(true);
    expect(r.totalXpEarned).toBe(240);
  });

  test("missing xpAwarded defaults to 0", () => {
    const r = splitProperties({ properties: [] });
    expect(r.totalXpEarned).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. VerdictCard.bonusPillText
// ═══════════════════════════════════════════════════════════════════════════════

describe("VerdictCard.bonusPillText — 2-prop = 1.5×, 3+ prop = 2×", () => {
  test("1 prop returns null (no pill rendered)", () => {
    expect(bonusPillText(1)).toBeNull();
    expect(bonusPillText(0)).toBeNull();
  });

  test("2 props → '1.5× bonus!'", () => {
    expect(bonusPillText(2)).toBe("1.5× bonus!");
  });

  test("3 props → '2× multi-property bonus!'", () => {
    expect(bonusPillText(3)).toBe("2× multi-property bonus!");
  });

  test("4 and 5 props → still 2× (flat past 3)", () => {
    expect(bonusPillText(4)).toBe("2× multi-property bonus!");
    expect(bonusPillText(5)).toBe("2× multi-property bonus!");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. VerdictCard.stripAutoCorrectedTag
// ═══════════════════════════════════════════════════════════════════════════════

describe("VerdictCard.stripAutoCorrectedTag", () => {
  test("removes a single inline tag", () => {
    expect(stripAutoCorrectedTag("This passes [auto-corrected: hedge]"))
      .toBe("This passes");
  });

  test("removes multiple tags", () => {
    // The regex consumes \s* before [auto-corrected:...], so adjacent
    // tags collapse to single spaces, not double.
    expect(stripAutoCorrectedTag("a [auto-corrected: x] b [auto-corrected: y] c"))
      .toBe("a b c");
  });

  test("no-op when no tag present", () => {
    expect(stripAutoCorrectedTag("clean reasoning")).toBe("clean reasoning");
  });

  test("trims trailing whitespace after strip", () => {
    expect(stripAutoCorrectedTag("done [auto-corrected: hedge]   ")).toBe("done");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. VerdictCard.headerTitle
// ═══════════════════════════════════════════════════════════════════════════════

describe("VerdictCard.headerTitle — singular/plural", () => {
  test("0 → Almost…", () => expect(headerTitle(0)).toBe("Almost…"));
  test("1 → 1 property found!", () => expect(headerTitle(1)).toBe("1 property found!"));
  test("2 → 2 properties found!", () => expect(headerTitle(2)).toBe("2 properties found!"));
  test("3 → 3 properties found!", () => expect(headerTitle(3)).toBe("3 properties found!"));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. RateLimitWall.secondsUntil
// ═══════════════════════════════════════════════════════════════════════════════

describe("RateLimitWall.secondsUntil", () => {
  test("null target → 0", () => {
    expect(secondsUntil(null)).toBe(0);
  });

  test("past target → 0 (never negative)", () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    expect(secondsUntil(past)).toBe(0);
  });

  test("future target → positive seconds (within tolerance)", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const s = secondsUntil(future);
    expect(s).toBeGreaterThan(58);
    expect(s).toBeLessThanOrEqual(60);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. RateLimitWall.formatCountdown
// ═══════════════════════════════════════════════════════════════════════════════

describe("RateLimitWall.formatCountdown — HH:MM:SS", () => {
  test("0 → 00:00:00", () => expect(formatCountdown(0)).toBe("00:00:00"));
  test("59 → 00:00:59", () => expect(formatCountdown(59)).toBe("00:00:59"));
  test("60 → 00:01:00", () => expect(formatCountdown(60)).toBe("00:01:00"));
  test("3661 → 01:01:01", () => expect(formatCountdown(3661)).toBe("01:01:01"));
  test("pads single-digit components", () => {
    expect(formatCountdown(7)).toBe("00:00:07");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. RateLimitWall.approachingLimitMath
// ═══════════════════════════════════════════════════════════════════════════════

describe("RateLimitWall.approachingLimitMath", () => {
  test("at 80% (40/50) → 10 left, 80%", () => {
    const r = approachingLimitMath(40, 50);
    expect(r.remaining).toBe(10);
    expect(r.pct).toBe(80);
    expect(r.remainingLabel).toBe("10 scans left today");
  });

  test("singular '1 scan' when remaining=1", () => {
    expect(approachingLimitMath(49, 50).remainingLabel).toBe("1 scan left today");
  });

  test("at 100% (50/50) → 0 left, 100%", () => {
    const r = approachingLimitMath(50, 50);
    expect(r.remaining).toBe(0);
    expect(r.pct).toBe(100);
    expect(r.remainingLabel).toBe("0 scans left today");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. StreakHeatmap.isoOffset
// ═══════════════════════════════════════════════════════════════════════════════

describe("StreakHeatmap.isoOffset", () => {
  test("returns YYYY-MM-DD shape", () => {
    expect(isoOffset(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isoOffset(7)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("0 days back ≠ 1 day back", () => {
    expect(isoOffset(0)).not.toBe(isoOffset(1));
  });

  test("offset goes backward in time", () => {
    expect(isoOffset(7) < isoOffset(0)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. StreakHeatmap.last28Days
// ═══════════════════════════════════════════════════════════════════════════════

describe("StreakHeatmap.last28Days", () => {
  test("length is 28", () => {
    expect(last28Days()).toHaveLength(28);
  });

  test("oldest first (sorted ascending)", () => {
    const days = last28Days();
    for (let i = 1; i < days.length; i++) {
      expect(days[i - 1] <= days[i]).toBe(true);
    }
  });

  test("the last entry is today", () => {
    const days = last28Days();
    expect(days[days.length - 1]).toBe(isoOffset(0));
  });

  test("all unique", () => {
    const days = last28Days();
    expect(new Set(days).size).toBe(28);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. StreakHeatmap.padDaysToWeeks
// ═══════════════════════════════════════════════════════════════════════════════

describe("StreakHeatmap.padDaysToWeeks — Sunday alignment", () => {
  test("DAY_LABELS starts with Sunday", () => {
    expect(DAY_LABELS[0]).toBe("Sun");
  });

  test("28 days returns 4 or 5 weeks (depending on starting day)", () => {
    const weeks = padDaysToWeeks(last28Days());
    expect(weeks.length).toBeGreaterThanOrEqual(4);
    expect(weeks.length).toBeLessThanOrEqual(5);
  });

  test("first cell of first week aligns to Sunday slot (null padding)", () => {
    const days     = last28Days();
    const firstDow = new Date(days[0]).getDay(); // 0=Sun..6=Sat
    const weeks    = padDaysToWeeks(days);
    // The first `firstDow` entries of week[0] must be null (padding).
    for (let i = 0; i < firstDow; i++) {
      expect(weeks[0][i]).toBeNull();
    }
    // The next entry IS the actual first day.
    expect(weeks[0][firstDow]).toBe(days[0]);
  });

  test("each non-final week has exactly 7 entries", () => {
    const weeks = padDaysToWeeks(last28Days());
    for (let i = 0; i < weeks.length - 1; i++) {
      expect(weeks[i]).toHaveLength(7);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. StreakBar.flameOpacities
// ═══════════════════════════════════════════════════════════════════════════════

describe("StreakBar.flameOpacities — 7-flame display", () => {
  test("returns 7 opacities", () => {
    expect(flameOpacities(0)).toHaveLength(7);
  });

  test("0 streak → all dim (0.18)", () => {
    expect(flameOpacities(0).every((o) => o === 0.18)).toBe(true);
  });

  test("3 streak → first 3 lit, last 4 dim", () => {
    expect(flameOpacities(3)).toEqual([1, 1, 1, 0.18, 0.18, 0.18, 0.18]);
  });

  test("7 streak → all lit", () => {
    expect(flameOpacities(7).every((o) => o === 1)).toBe(true);
  });

  test("> 7 streak still all lit (no out-of-bounds)", () => {
    expect(flameOpacities(99).every((o) => o === 1)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. StreakBar.progressHintText
// ═══════════════════════════════════════════════════════════════════════════════

describe("StreakBar.progressHintText", () => {
  test("0 streak → null (different message handles it)", () => {
    expect(progressHintText(0)).toBeNull();
  });

  test("7+ streak → null (multiplier already active)", () => {
    expect(progressHintText(7)).toBeNull();
    expect(progressHintText(99)).toBeNull();
  });

  test("6 → '1 more day' (singular)", () => {
    expect(progressHintText(6)).toBe("1 more day to 2× XP!");
  });

  test("5 → '2 more days' (plural)", () => {
    expect(progressHintText(5)).toBe("2 more days to 2× XP!");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. DailyQuestBanner.computeMaxXpFirst
// ═══════════════════════════════════════════════════════════════════════════════

describe("DailyQuestBanner.computeMaxXpFirst — formula matches Edge Function", () => {
  test("1 prop @ 40 → 40 (1.0× multiplier)", () => {
    expect(computeMaxXpFirst(40, 1)).toBe(40);
  });

  test("2 props @ 40 → 120 (1.5× multiplier × 2)", () => {
    expect(computeMaxXpFirst(40, 2)).toBe(120);
  });

  test("3 props @ 40 → 240 (2.0× multiplier × 3)", () => {
    expect(computeMaxXpFirst(40, 3)).toBe(240);
  });

  test("4 props @ 40 → 320 (2.0× × 4)", () => {
    expect(computeMaxXpFirst(40, 4)).toBe(320);
  });

  test("uses xp_reward_first_try from quest, not the constant", () => {
    expect(computeMaxXpFirst(100, 3)).toBe(600); // 100 × 3 × 2
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. DailyQuestBanner.dailyXpDisplay
// ═══════════════════════════════════════════════════════════════════════════════

describe("DailyQuestBanner.dailyXpDisplay", () => {
  test("non-2× multiplier → base XP string", () => {
    expect(dailyXpDisplay(40, 3, false)).toBe("240 XP");
  });

  test("2× multiplier doubles the displayed value", () => {
    expect(dailyXpDisplay(40, 3, true)).toBe("480 XP");
  });

  test("1 prop, no 2× → 40 XP", () => {
    expect(dailyXpDisplay(40, 1, false)).toBe("40 XP");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 15. RecentSessionsPanel.formatRelative
// ═══════════════════════════════════════════════════════════════════════════════

describe("RecentSessionsPanel.formatRelative", () => {
  const fixedNow = new Date("2026-05-03T12:00:00");

  test("today → 'Today, <time>'", () => {
    const today = new Date("2026-05-03T09:30:00").toISOString();
    expect(formatRelative(today, fixedNow)).toMatch(/^Today,/);
  });

  test("yesterday → 'Yesterday, <time>'", () => {
    const yesterday = new Date("2026-05-02T09:30:00").toISOString();
    expect(formatRelative(yesterday, fixedNow)).toMatch(/^Yesterday,/);
  });

  test("older than yesterday → '<weekday>, <day> <month>'", () => {
    const old = new Date("2026-04-25T09:30:00").toISOString();
    const out = formatRelative(old, fixedNow);
    // Should NOT start with Today or Yesterday.
    expect(out).not.toMatch(/^Today,/);
    expect(out).not.toMatch(/^Yesterday,/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 16. RecentSessionsPanel.formatDuration
// ═══════════════════════════════════════════════════════════════════════════════

describe("RecentSessionsPanel.formatDuration", () => {
  test("null → em-dash", () => expect(formatDuration(null)).toBe("—"));
  test("under 60s → seconds", () => expect(formatDuration(45)).toBe("45s"));
  test("exactly 60s → 1m", () => expect(formatDuration(60)).toBe("1m"));
  test("125s → 2m 5s", () => expect(formatDuration(125)).toBe("2m 5s"));
  test("exactly 3600s → 1h", () => expect(formatDuration(3600)).toBe("1h"));
  test("3725s → 1h 2m", () => expect(formatDuration(3725)).toBe("1h 2m"));
  test("0 seconds → '0s'", () => expect(formatDuration(0)).toBe("0s"));
});
