/**
 * hooks/useGatedPaywall.tsx
 * Skanlore — one shared "parent PIN gate → PaywallScreen" path.
 *
 * WHY THIS EXISTS
 * ---------------
 * The parental-gate-before-paywall pattern was hand-rolled twice, in two
 * screens, from the same parts (ParentPinGateModal + a supabase.auth.getUser
 * effect + a pinGateVisible state + a navigate("Paywall") on success). Each
 * new upsell surface that forgot to replicate it re-opened the exact gap the
 * pattern was meant to close: a child, one tap from a real purchasePackage()
 * call. That gap has now been found twice (QuestMap locked-card tap; the
 * daily-scan-cap RateLimitWall). This hook makes the gated path the default
 * so a *future* upsell surface can't accidentally ship ungated — it wires
 * itself up with one call plus the shared modal rendered once.
 *
 * WHAT IT GUARANTEES
 * ------------------
 * Calling openGate(reason) NEVER navigates straight to the paywall. It always
 * opens ParentPinGateModal first; the Paywall navigation happens only inside
 * the modal's onSuccess. Dismissing the gate navigates nowhere. This is the
 * same behaviour QuestMapScreen and ChildSwitcherScreen already ship — pulled
 * into one place, not changed.
 *
 * USAGE
 * -----
 *   const { openGate, gateProps } = useGatedPaywall(navigation);
 *   // ...wire a child-facing button to open the gate:
 *   <Button onPress={() => openGate("rate-limit-daily")} />
 *   // ...and render the SHARED, module-level modal once, anywhere in the
 *   //    component's tree, spreading the gate props onto it:
 *   <ParentPinGateModal {...gateProps} />
 *
 * WHY gateProps — AND NOT A RETURNED <GateModal/> COMPONENT
 * --------------------------------------------------------
 * An earlier version returned a `GateModal` component built with useCallback
 * whose deps included `visible`. Rendering <GateModal/> then changed the
 * element *type* on every open/close, so React unmounted + remounted the
 * underlying ParentPinGateModal each time instead of just re-rendering it with
 * a new `visible` prop. Two consequences: the modal's exit transition was
 * skipped (abrupt dismiss / iOS flicker), and — the real hazard for a hook
 * meant to be REUSED — any dep-identity change while the gate was open would
 * remount it mid-entry and wipe the child's half-typed PIN. Returning plain
 * props and letting the caller render the stable, module-level
 * ParentPinGateModal directly (exactly how ChildSwitcherScreen/QuestMapScreen
 * already do it) keeps a single mounted instance whose `visible` prop simply
 * toggles.
 *
 * The `reason` string is passed through to PaywallScreen unchanged (it drives
 * paywall copy/analytics). Existing reasons in use: "quest-locked",
 * "parent-dashboard", "export-tome-locked", "generate-quest-locked".
 *
 * NOTE ON SCOPE
 * -------------
 * This intentionally does NOT try to replace the ChildSwitcher child-deletion
 * gate — that one gates a *delete*, not a paywall, and branches its onSuccess
 * between two different actions. Folding it in here would over-generalise the
 * hook past the one job it does well. Left as-is on purpose.
 */

import { useCallback, useEffect, useState } from "react";

import { supabase } from "../lib/supabase";

/**
 * Minimal structural type for what this hook actually needs from navigation:
 * the ability to navigate to the Paywall route. Typed structurally (not as
 * NativeStackNavigationProp<RootStackParamList, SomeRoute>) so any screen's
 * `navigation` prop is accepted regardless of which route it's parameterised
 * on — avoids route-name variance friction while still type-checking the one
 * call this hook makes.
 */
type PaywallNavigator = {
  navigate: (screen: "Paywall", params: { reason?: string }) => void;
};

/**
 * Props to spread onto the shared <ParentPinGateModal {...gateProps} />.
 * Shape mirrors ParentPinGateModalProps structurally (kept inline so this hook
 * doesn't force an export from the modal file).
 */
export interface GateProps {
  visible:     boolean;
  parentId:    string;
  parentEmail: string;
  onSuccess:   () => void;
  onDismiss:   () => void;
}

export interface UseGatedPaywallResult {
  /**
   * Opens the parent PIN gate. On successful PIN entry, navigates to
   * PaywallScreen with the given reason. On dismiss, does nothing. Safe to
   * wire directly to a child-facing button — the child cannot reach the
   * paywall without an adult completing the gate.
   */
  openGate: (reason: string) => void;
  /**
   * Spread onto a single <ParentPinGateModal {...gateProps} /> rendered once
   * in the caller's tree. The modal is a stable, module-level component, so a
   * changing gateProps object re-renders that one instance rather than
   * remounting it.
   */
  gateProps: GateProps;
}

export function useGatedPaywall(navigation: PaywallNavigator): UseGatedPaywallResult {
  const [visible, setVisible] = useState(false);
  const [reason, setReason]   = useState<string>("upgrade");
  const [parentId, setParentId]       = useState("");
  const [parentEmail, setParentEmail] = useState("");

  // Same identity fetch QuestMapScreen/ChildSwitcherScreen already do. The
  // gate modal needs parentId (to look up / set the stored PIN) and
  // parentEmail (for the forgot-PIN reset path).
  useEffect(() => {
    let cancelled = false;
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (cancelled || !user) return;
      setParentId(user.id);
      setParentEmail(user.email ?? "");
    });
    return () => { cancelled = true; };
  }, []);

  const openGate = useCallback((r: string) => {
    setReason(r);
    setVisible(true);
  }, []);

  const onSuccess = useCallback(() => {
    setVisible(false);
    navigation.navigate("Paywall", { reason });
  }, [navigation, reason]);

  const onDismiss = useCallback(() => {
    setVisible(false);
  }, []);

  return {
    openGate,
    gateProps: { visible, parentId, parentEmail, onSuccess, onDismiss },
  };
}
