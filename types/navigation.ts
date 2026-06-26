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
  ChildSwitcher:       undefined;
  QuestMap:            undefined;
  Scan:                { questId: string; hardMode?: boolean };
  ParentDashboard:     undefined;
  SpellBook:           undefined;
  QuestGenerator:      undefined;
  Onboarding:          undefined;
  OnboardingBackstory: undefined;
  Paywall:             { reason?: string } | undefined;
};

/**
 * Global default param list for React Navigation.
 *
 * Augmenting `ReactNavigation.RootParamList` makes every *untyped* navigation
 * primitive — `useNavigation()`, `useNavigationContainerRef()`, `<Link>`, the
 * container `ref` — resolve to these routes instead of the empty default.
 *
 * Why this is required: since @react-navigation/core 7.21.x, the container
 * ref's `getCurrentRoute()` returns `MaybeParamListRoute<ParamList>`, which
 * collapses to `never` when the default param list is the empty `{}`. That made
 * `navigationRef.getCurrentRoute()?.name` fail to typecheck across App.tsx.
 * With this augmentation the default param list is non-empty, so the route is
 * correctly typed and `.name` resolves to a screen-name union.
 *
 * Adding a screen still happens in RootStackParamList above ONLY — this picks
 * it up automatically.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList, AuthStackParamList {}
  }
}
