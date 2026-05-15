/**
 * types/navigation.ts
 * ───────────────────
 * Single source of truth for all React Navigation param lists.
 *
 * Import in every screen and in App.tsx:
 *   import type { RootStackParamList, AuthStackParamList } from "../types/navigation";
 *
 * App.tsx is one level up from types/, so its import path is:
 *   import type { RootStackParamList, AuthStackParamList } from "./types/navigation";
 *
 * Adding a new screen? Add it here ONLY. Every file picks it up automatically.
 */

export type AuthStackParamList = {
  Auth: undefined;
};

export type RootStackParamList = {
  ChildSwitcher:   undefined;
  QuestMap:        undefined;
  Scan:            { questId: string; hardMode?: boolean };
  ParentDashboard: undefined;
  SpellBook:       undefined;
  QuestGenerator:  undefined;
  Onboarding:      undefined;
  Paywall:         { reason?: string } | undefined;
};
