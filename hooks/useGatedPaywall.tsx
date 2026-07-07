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
 * itself up with one call and one rendered element.
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
 *   const { openGate, GateModal } = useGatedPaywall(navigation);
 *   // ...
 *   <Button onPress={() => openGate("rate-limit-daily")} />
 *   // ...at the end of the component's render tree:
 *   <GateModal />
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

import React, { useCallback, useEffect, useState } from "react";

import { ParentPinGateModal } from "../components/ParentPinGateModal";
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

export interface UseGatedPaywallResult {
  /**
   * Opens the parent PIN gate. On successful PIN entry, navigates to
   * PaywallScreen with the given reason. On dismiss, does nothing. Safe to
   * wire directly to a child-facing button — the child cannot reach the
   * paywall without an adult completing the gate.
   */
  openGate: (reason: string) => void;
  /**
   * Render this once, anywhere in the component's tree (order doesn't matter —
   * it's a modal). It owns the gate's visibility internally.
   */
  GateModal: React.FC;
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

  const GateModal: React.FC = useCallback(() => (
    <ParentPinGateModal
      visible={visible}
      parentId={parentId}
      parentEmail={parentEmail}
      onSuccess={() => {
        setVisible(false);
        navigation.navigate("Paywall", { reason });
      }}
      onDismiss={() => setVisible(false)}
    />
  ), [visible, parentId, parentEmail, reason, navigation]);

  return { openGate, GateModal };
}
