/**
 * screens/PaywallScreen.tsx
 * Lexi-Lens — Phase 4.4 paywall.
 *
 * Custom paywall (not RevenueCat-hosted) because:
 *   • react-native-purchases-ui has incompatibility issues with Expo SDK 54
 *     (RC issue #1450 — PurchasesHybridCommonUI pod resolution fails).
 *   • A kids' brand needs design control — Lexi-Lens purple/amber, magical
 *     framing, no generic SaaS upsell language.
 *   • Custom paywall composes packages from RC's `getOfferings()` and calls
 *     `purchasePackage()` on tap — same purchase flow, our look.
 *
 * Mounted as a modal route ("Paywall") via the root stack. Triggers:
 *   • QuestMapScreen — tapping a locked premium quest
 *   • ParentDashboard — tapping the "Upgrade" CTA in the subscription card
 *   • RateLimitWall — tapping "Upgrade for unlimited scans"
 *
 * Required App Store / Play Store elements (Apple guideline 3.1.2):
 *   • "Restore Purchases" button — always visible
 *   • Privacy Policy + Terms of Service links — visible before purchase
 *   • Auto-renewal disclosure copy for monthly/annual plans
 *   • Price + period clearly shown per package
 *
 * In __DEV__ (where RC is intentionally not initialized — see
 * lib/revenueCat.ts), this screen renders a "Dev preview" mode with a mock
 * package and disabled CTA, so layout work doesn't require a TestFlight loop.
 */

import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Linking,
  Alert,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";

import {
  fetchCurrentOffering,
  purchasePackage,
  restorePurchases,
  isConfigured,
  type PurchasesPackage,
  type PurchasesOffering,
} from "../lib/revenueCat";
import { useGameStore } from "../store/gameStore";
import type { RootStackParamList } from "../types/navigation";

type Props = NativeStackScreenProps<RootStackParamList, "Paywall">;

// ─── Palette ──────────────────────────────────────────────────────────────

const P = {
  bg:            "#0f0620",
  cardBg:        "rgba(124,58,237,0.10)",
  cardBorder:    "rgba(124,58,237,0.35)",
  cardSelectBg:  "rgba(245,200,66,0.10)",
  cardSelectBd:  "rgba(245,200,66,0.65)",
  primary:       "#7c3aed",
  primaryDim:    "#5b21b6",
  accent:        "#f5c842",
  accentDim:     "#7a6a3a",
  textPrimary:   "#f5f3ff",
  textSecondary: "#c4b5fd",
  textMuted:     "#a78bfa",
  textDim:       "#6b7280",
  success:       "#22c55e",
  error:         "#ef4444",
  divider:       "rgba(255,255,255,0.08)",
};

// ─── Bullet line ──────────────────────────────────────────────────────────

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.bullet}>
      <Text style={styles.bulletDot}>✦</Text>
      <Text style={styles.bulletText}>{children}</Text>
    </View>
  );
}

// ─── Package card ─────────────────────────────────────────────────────────

interface PackageCardProps {
  pkg:        PurchasesPackage;
  selected:   boolean;
  onSelect:   () => void;
  highlight?: string;
}

function PackageCard({ pkg, selected, onSelect, highlight }: PackageCardProps) {
  // RC's package types: ANNUAL, MONTHLY, etc. Use these for the title rather
  // than the raw product identifier (more localized, more user-readable).
  const title = packageTitle(pkg);
  const price = pkg.product.priceString;
  const perUnit = perUnitString(pkg);

  return (
    <TouchableOpacity
      style={[styles.pkgCard, selected && styles.pkgCardSelected]}
      onPress={onSelect}
      activeOpacity={0.85}
    >
      {highlight && (
        <View style={styles.pkgBadge}>
          <Text style={styles.pkgBadgeText}>{highlight}</Text>
        </View>
      )}
      <View style={styles.pkgRow}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.pkgTitle, selected && { color: P.accent }]}>{title}</Text>
          {perUnit && <Text style={styles.pkgSubtitle}>{perUnit}</Text>}
        </View>
        <Text style={[styles.pkgPrice, selected && { color: P.accent }]}>{price}</Text>
      </View>
    </TouchableOpacity>
  );
}

function packageTitle(pkg: PurchasesPackage): string {
  switch (pkg.packageType) {
    case "ANNUAL":     return "Yearly";
    case "MONTHLY":    return "Monthly";
    case "WEEKLY":     return "Weekly";
    case "TWO_MONTH":  return "Every 2 months";
    case "THREE_MONTH":return "Every 3 months";
    case "SIX_MONTH":  return "Every 6 months";
    case "LIFETIME":   return "Lifetime";
    default:           return pkg.product.title || "Premium";
  }
}

function perUnitString(pkg: PurchasesPackage): string | null {
  // Render "≈ ₹29/mo" under the annual price when we can compute it.
  if (pkg.packageType !== "ANNUAL") return null;
  const price = pkg.product.price;
  if (!price || price <= 0) return null;
  const perMonth = price / 12;
  const currency = pkg.product.currencyCode || "";
  const formatted = perMonth.toFixed(2);
  return `≈ ${currency} ${formatted}/month`;
}

// ─── Highlight selector ───────────────────────────────────────────────────
//
// "Best value" badge goes on the annual package when both monthly + annual
// are present. Computed at render time, not configured in RC, so we don't
// need to edit dashboard metadata to change the marketing language.

function packageHighlights(pkgs: PurchasesPackage[]): Map<string, string> {
  const map = new Map<string, string>();
  const annual = pkgs.find((p) => p.packageType === "ANNUAL");
  const monthly = pkgs.find((p) => p.packageType === "MONTHLY");
  if (annual && monthly) {
    const monthlyAnnualised = monthly.product.price * 12;
    const annualPrice       = annual.product.price;
    if (monthlyAnnualised > 0) {
      const saved = Math.round((1 - annualPrice / monthlyAnnualised) * 100);
      if (saved >= 5) map.set(annual.identifier, `Save ${saved}%`);
      else            map.set(annual.identifier, "Best value");
    } else {
      map.set(annual.identifier, "Best value");
    }
  } else if (annual && !monthly) {
    map.set(annual.identifier, "Best value");
  }
  return map;
}

// ─── Screen ───────────────────────────────────────────────────────────────

export default function PaywallScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const reason = route.params?.reason ?? "premium";

  const [loading,  setLoading]  = useState(true);
  const [offering, setOffering] = useState<PurchasesOffering | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  const [restoring,  setRestoring]  = useState(false);

  const setSubscriptionFromRC = useGameStore((s) => s.setSubscriptionFromRC);

  // Initial fetch
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const off = await fetchCurrentOffering();
      if (cancelled) return;
      setOffering(off);
      // Pre-select annual if available; else first package.
      if (off?.availablePackages?.length) {
        const annual = off.availablePackages.find((p) => p.packageType === "ANNUAL");
        setSelected(annual?.identifier ?? off.availablePackages[0].identifier);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Actions ────────────────────────────────────────────────────────────

  const handleClose = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    navigation.goBack();
  }, [navigation]);

  const handleSelect = useCallback((id: string) => {
    Haptics.selectionAsync();
    setSelected(id);
  }, []);

  const handlePurchase = useCallback(async () => {
    if (!offering || !selected || purchasing) return;
    const pkg = offering.availablePackages.find((p) => p.identifier === selected);
    if (!pkg) return;

    if (!isConfigured()) {
      Alert.alert(
        "Not available",
        "Purchases aren't available in this build. Please run a release build on TestFlight or Play Internal Testing.",
      );
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setPurchasing(true);
    const outcome = await purchasePackage(pkg);
    setPurchasing(false);

    if (outcome.kind === "success") {
      // Update store immediately — webhook will follow.
      setSubscriptionFromRC(outcome.details);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("✨ Welcome to Premium!", "Your account is now Premium.", [
        { text: "Continue", onPress: () => navigation.goBack() },
      ]);
    } else if (outcome.kind === "cancelled") {
      // No alert — cancel is silent UX.
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Purchase failed", outcome.message);
    }
  }, [offering, selected, purchasing, navigation, setSubscriptionFromRC]);

  const handleRestore = useCallback(async () => {
    if (restoring) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setRestoring(true);
    const result = await restorePurchases();
    setRestoring(false);

    if (result?.details.isActive) {
      setSubscriptionFromRC(result.details);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Purchases restored", "Your Premium subscription has been restored.", [
        { text: "Continue", onPress: () => navigation.goBack() },
      ]);
    } else {
      Alert.alert(
        "Nothing to restore",
        "We couldn't find an active purchase on this account. If you believe this is an error, contact support.",
      );
    }
  }, [restoring, navigation, setSubscriptionFromRC]);

  const handlePrivacy = useCallback(() => {
    Linking.openURL("https://lexilens.app/privacy-policy").catch(() => null);
  }, []);

  const handleTerms = useCallback(() => {
    Linking.openURL("https://lexilens.app/terms").catch(() => null);
  }, []);

  const handleManage = useCallback(() => {
    // Deep link to App Store / Play Store subscription management.
    const url = Platform.OS === "ios"
      ? "https://apps.apple.com/account/subscriptions"
      : "https://play.google.com/store/account/subscriptions";
    Linking.openURL(url).catch(() => null);
  }, []);

  // ── Render states ──────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator size="large" color={P.accent} />
      </View>
    );
  }

  // RC not configured (most likely __DEV__ or missing keys) — render preview-only.
  if (!offering && !isConfigured()) {
    return (
      <View style={[styles.screen]}>
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>✕</Text>
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: insets.bottom + 40 }}>
          <Text style={styles.title}>✦ Premium Preview</Text>
          <Text style={styles.subtitle}>
            Paywall is not active in this build. Run a release build on TestFlight or Play Internal Testing
            to test purchases.
          </Text>
          <View style={styles.bullets}>
            {/* HONEST COPY (audit 2026-05-17): only claim what is actually
                enforced in code today. tier1 cap = 20/day, free = 5/day
                (tier_config). Do NOT re-add quest-count / AI-quest /
                hard-mode / sibling bullets until each is genuinely
                premium-gated. */}
            <Bullet>20 scans per day — 4x the free daily limit of 5</Bullet>
          </View>
        </ScrollView>
      </View>
    );
  }

  // RC configured but no offering — surface this to the user with actionable copy.
  if (!offering) {
    return (
      <View style={[styles.screen]}>
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>✕</Text>
          </TouchableOpacity>
        </View>
        <View style={[styles.center, { padding: 24 }]}>
          <Text style={styles.title}>Premium</Text>
          <Text style={styles.subtitle}>
            We couldn't load purchase options. Please check your connection and try again.
          </Text>
          <TouchableOpacity style={styles.restoreBtn} onPress={handleRestore} disabled={restoring}>
            {restoring
              ? <ActivityIndicator color={P.textPrimary} />
              : <Text style={styles.restoreBtnText}>Restore Purchases</Text>}
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const packages = offering.availablePackages;
  const highlights = packageHighlights(packages);

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
          <Text style={styles.closeBtnText}>✕</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 24, paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>✦ Unlock Premium</Text>
        <Text style={styles.subtitle}>
          {reasonCopy(reason)}
        </Text>

        <View style={styles.bullets}>
          {/* HONEST COPY (audit 2026-05-17): the four removed bullets
              describe features that are NOT premium-gated in this build
              (AI quests, hard mode, sibling profiles are free for everyone;
              zero paid-tier quests are seeded). Restore each only after it
              is actually gated. */}
          <Bullet>20 scans per day — 4x the free daily limit of 5</Bullet>
        </View>

        <View style={styles.divider} />

        <Text style={styles.pkgGroupLabel}>Choose your plan</Text>

        {packages.map((p) => (
          <PackageCard
            key={p.identifier}
            pkg={p}
            selected={selected === p.identifier}
            onSelect={() => handleSelect(p.identifier)}
            highlight={highlights.get(p.identifier)}
          />
        ))}

        <TouchableOpacity
          style={[styles.cta, (purchasing || !selected) && styles.ctaDisabled]}
          onPress={handlePurchase}
          disabled={purchasing || !selected}
          activeOpacity={0.85}
        >
          {purchasing
            ? <ActivityIndicator color={P.bg} />
            : <Text style={styles.ctaText}>
                {hasIntroOffer(packages, selected) ? "Start Free Trial" : "Subscribe"}
              </Text>
          }
        </TouchableOpacity>

        <Text style={styles.legalBlock}>
          Auto-renewable subscription. Cancel anytime in your {Platform.OS === "ios" ? "Apple ID" : "Google Play"} account
          settings. Payment is charged to your account at purchase confirmation. Subscription auto-renews unless
          cancelled at least 24 hours before the end of the current period.
        </Text>

        <View style={styles.linkRow}>
          <TouchableOpacity onPress={handleRestore} disabled={restoring}>
            {restoring
              ? <ActivityIndicator color={P.textMuted} size="small" />
              : <Text style={styles.link}>Restore Purchases</Text>}
          </TouchableOpacity>
          <Text style={styles.linkSep}>·</Text>
          <TouchableOpacity onPress={handleManage}>
            <Text style={styles.link}>Manage</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.linkRow}>
          <TouchableOpacity onPress={handlePrivacy}>
            <Text style={styles.link}>Privacy Policy</Text>
          </TouchableOpacity>
          <Text style={styles.linkSep}>·</Text>
          <TouchableOpacity onPress={handleTerms}>
            <Text style={styles.link}>Terms of Service</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

function hasIntroOffer(pkgs: PurchasesPackage[], selectedId: string | null): boolean {
  if (!selectedId) return false;
  const pkg = pkgs.find((p) => p.identifier === selectedId);
  // RC product has `introPrice` populated when an introductory offer is configured.
  return !!pkg?.product?.introPrice;
}

function reasonCopy(reason: string): string {
  switch (reason) {
    case "rate-limit":
      return "You've hit today's free scan limit. Premium gives you unlimited daily scans and the full quest library.";
    case "quest-locked":
      return "This is a Premium quest. Unlock the full quest library, custom AI quests, and unlimited scans.";
    case "parent-dashboard":
      return "Take your child's adventure further with the full Premium experience.";
    default:
      return "Unlock the full Lexi-Lens adventure for your child.";
  }
}

// ─── Styles ───────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: P.bg,
  },
  center: { alignItems: "center", justifyContent: "center", flex: 1 },

  header: {
    flexDirection:   "row",
    justifyContent:  "flex-end",
    paddingHorizontal: 16,
    paddingBottom:   4,
  },
  closeBtn: {
    width:          36,
    height:         36,
    borderRadius:   18,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems:     "center",
    justifyContent: "center",
  },
  closeBtnText: { fontSize: 18, color: P.textPrimary, fontWeight: "600" },

  title: {
    fontSize:   28,
    fontWeight: "800",
    color:      P.textPrimary,
    marginBottom: 8,
    letterSpacing: 0.3,
  },
  subtitle: {
    fontSize:   15,
    color:      P.textSecondary,
    lineHeight: 22,
    marginBottom: 24,
  },

  bullets: { gap: 10, marginBottom: 8 },
  bullet:  { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  bulletDot:  { fontSize: 14, color: P.accent, marginTop: 1 },
  bulletText: { fontSize: 14, color: P.textPrimary, flex: 1, lineHeight: 20 },

  divider: {
    height: 1,
    backgroundColor: P.divider,
    marginVertical: 20,
  },

  pkgGroupLabel: {
    fontSize:     11,
    color:        P.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginBottom: 10,
    fontWeight:   "700",
  },

  pkgCard: {
    backgroundColor: P.cardBg,
    borderRadius: 14,
    borderWidth:  1,
    borderColor:  P.cardBorder,
    padding:      14,
    marginBottom: 10,
    position:     "relative",
  },
  pkgCardSelected: {
    backgroundColor: P.cardSelectBg,
    borderColor:     P.cardSelectBd,
    borderWidth:     1.5,
  },
  pkgRow:    { flexDirection: "row", alignItems: "center" },
  pkgTitle:  { fontSize: 16, color: P.textPrimary, fontWeight: "700" },
  pkgSubtitle: { fontSize: 12, color: P.textMuted, marginTop: 2 },
  pkgPrice:  { fontSize: 18, color: P.textPrimary, fontWeight: "800" },

  pkgBadge: {
    position:        "absolute",
    top:             -10,
    right:           12,
    backgroundColor: P.accent,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius:    10,
  },
  pkgBadgeText: {
    fontSize:   10,
    fontWeight: "800",
    color:      P.bg,
    letterSpacing: 0.5,
  },

  cta: {
    marginTop:    18,
    height:       54,
    borderRadius: 14,
    backgroundColor: P.accent,
    alignItems:   "center",
    justifyContent: "center",
  },
  ctaDisabled: { backgroundColor: P.accentDim },
  ctaText:     { fontSize: 17, fontWeight: "800", color: P.bg, letterSpacing: 0.4 },

  restoreBtn: {
    marginTop:    14,
    height:       46,
    borderRadius: 12,
    borderWidth:  1,
    borderColor:  P.primary,
    paddingHorizontal: 20,
    alignItems:   "center",
    justifyContent: "center",
  },
  restoreBtnText: { fontSize: 14, fontWeight: "700", color: P.textSecondary },

  legalBlock: {
    fontSize:    11,
    color:       P.textDim,
    lineHeight:  16,
    marginTop:   14,
  },

  linkRow: {
    flexDirection:   "row",
    justifyContent:  "center",
    alignItems:      "center",
    gap:             8,
    marginTop:       14,
  },
  link:    { fontSize: 13, color: P.textMuted, textDecorationLine: "underline" },
  linkSep: { fontSize: 13, color: P.textDim },
});
