/**
 * lib/revenueCat.ts
 * Lexi-Lens — RevenueCat SDK wrapper.
 *
 * Phase 4.4 — paywall integration.
 *
 * Design principles
 * ─────────────────
 *
 * 1. **Lazy native-module load.** `react-native-purchases` is dynamically
 *    `import()`ed inside an async helper, not at module load. This protects
 *    every file that touches `./revenueCat` from RC's module-init side
 *    effects (event-emitter attach at line ~72 of purchases.js). Same
 *    pattern as the Lumi sound bootstrap in App.tsx, for the same reason —
 *    iOS bridgeless + new arch is unforgiving of synchronous native-module
 *    init failures during JS bundle resolution.
 *
 * 2. **Tolerant of missing keys.** If RC keys are absent (dev profile with
 *    no SANDBOX vars, misconfigured EAS profile, or unsupported platform
 *    like web), this module logs a single warning and short-circuits.
 *    The app boots normally; quest-locking still works against
 *    parents.subscription_tier in the DB (server-authoritative gate);
 *    paywall taps just show an informative alert instead of presenting RC.
 *    No code path throws.
 *
 * 3. **Dev-mode guard.** `react-native-purchases@10.x` has a known crash
 *    in __DEV__ on Expo SDK 54 + RN 0.81 + React 19 (RC issue #1436). RC's
 *    internal log handler routes a console event through Babel's
 *    wrapNativeSuper, which collides with @expo/metro-runtime's NamelessError
 *    capture and throws a Reflect.construct.apply error during emitter setup.
 *    Workaround: skip `Purchases.configure()` in `__DEV__`. Test paywall
 *    flows in EAS preview/staging builds, never in Expo Go or dev client.
 *
 * 4. **Single entitlement constant.** `ENTITLEMENT_PREMIUM = "premium"` is
 *    the entitlement identifier that must match RevenueCat Dashboard config.
 *    All entitlement checks reference this constant — never inline the
 *    string elsewhere. Phase 4.6 may introduce additional entitlements
 *    (e.g. "family") but keep this one stable.
 *
 * 5. **Source-of-truth strategy.** Server is authoritative
 *    (parents.subscription_tier updated by webhook). Client UI uses BOTH:
 *      • DB read (via gameStore.loadParentProfile) for fast initial render
 *      • RC SDK (Purchases.getCustomerInfo) for freshness — overrides DB
 *        if RC says active and DB says free (webhook lag is the common
 *        cause). RC subscribes to update events; gameStore listens and
 *        re-derives.
 *
 * 6. **No PII leakage.** RC `app_user_id` is set to the Supabase parent
 *    UUID — no email, no name, no child data ever leaves the device via
 *    RC. RevenueCat is COPPA-friendly when scoped this way.
 *
 * Webhook handles backend tier sync separately (see
 * supabase/functions/revenuecat-webhook/index.ts). This module is purely
 * client-side: paywall display, purchase initiation, restore, and
 * entitlement read-back for UI gating.
 */

import { Platform } from "react-native";
import { ENV } from "./env";
import { addGameBreadcrumb, Sentry } from "./sentry";

// Type-only imports — these are erased at compile time, no runtime cost,
// no module-init side effects. Safe at top level.
import type {
  CustomerInfo,
  PurchasesOffering,
  PurchasesPackage,
} from "react-native-purchases";

// Re-export the public types so consumers don't have to depend on the SDK
// package directly (keeps the swap-out / mock-out path tractable).
export type { CustomerInfo, PurchasesOffering, PurchasesPackage };

// ─── Public constants ─────────────────────────────────────────────────────

/**
 * Entitlement identifier configured in the RevenueCat Dashboard.
 * Every premium product (monthly, annual, family) grants THIS entitlement.
 *
 * If this string ever changes, update:
 *   • RC Dashboard → Entitlements (rename or add new)
 *   • supabase/functions/revenuecat-webhook/index.ts (ENTITLEMENT_ID const)
 *   • This file
 *
 * Don't rename casually — entitlement renames orphan existing subscribers.
 */
export const ENTITLEMENT_PREMIUM = "premium";

/**
 * Granular subscription state surfaced to UI / store.
 *
 * `tier` field maps RC product → our schema vocabulary:
 *   • free                                                     → 'free'
 *   • lexilens_premium_monthly | lexilens_premium_yearly        → 'tier1'
 *   • lexilens_family_monthly  | lexilens_family_yearly         → 'family'
 *
 * tier2 reserved for future "pro" plan (matches economics matrix v2.2).
 * Mapping logic lives in `tierFromProductId()` below; keep in sync with
 * the webhook handler (supabase/functions/revenuecat-webhook/index.ts).
 */
export interface SubscriptionDetails {
  isActive:        boolean;
  productId:       string | null;
  willRenew:       boolean;
  expirationDate:  number | null;   // ms since epoch
  managementUrl:   string | null;   // deep link to App Store / Play Store sub mgmt
  tier:            "free" | "tier1" | "tier2" | "family";
  /** Active in introductory period (free trial, intro price). */
  inGracePeriod:   boolean;
}

/** Default value used before RC has any data. */
export const FREE_SUBSCRIPTION: SubscriptionDetails = {
  isActive:       false,
  productId:      null,
  willRenew:      false,
  expirationDate: null,
  managementUrl:  null,
  tier:           "free",
  inGracePeriod:  false,
};

// ─── Private state ────────────────────────────────────────────────────────

let _configured = false;
let _identifiedUserId: string | null = null;

// Cache of the loaded module. null sentinel = not yet attempted; false = load
// failed and won't retry (avoid repeated failures spamming Sentry).
let _purchasesModule: typeof import("react-native-purchases") | null | false = null;

// Customer info listeners registered by consumers. We hold our own list so we
// can attach a single listener to the native SDK and fan out — avoids the
// per-subscriber overhead of binding multiple bridge listeners.
type InfoListener = (info: CustomerInfo) => void;
const _infoListeners = new Set<InfoListener>();
let _nativeListenerAttached = false;

// ─── Module loader ────────────────────────────────────────────────────────

async function loadPurchases(): Promise<typeof import("react-native-purchases") | null> {
  if (_purchasesModule === false) return null;
  if (_purchasesModule)            return _purchasesModule;
  try {
    const mod = await import("react-native-purchases");
    _purchasesModule = mod;
    return mod;
  } catch (err) {
    _purchasesModule = false;
    console.warn("[revenueCat] react-native-purchases failed to load:", err);
    Sentry.captureException(err, {
      tags: { component: "revenueCat", phase: "module-load" },
    });
    return null;
  }
}

function getApiKey(): string | null {
  if (Platform.OS === "ios")     return ENV.revenueCat.iosKey;
  if (Platform.OS === "android") return ENV.revenueCat.androidKey;
  return null;
}

// ─── Tier mapping ─────────────────────────────────────────────────────────
//
// Convention: product identifiers in App Store Connect / Play Console use
// the pattern `lexilens_<plan>_<cadence>`:
//
//   lexilens_premium_monthly    → tier1  (entry paid plan)
//   lexilens_premium_yearly     → tier1  (same entitlement, ~48% discount)
//   lexilens_family_monthly     → family
//   lexilens_family_yearly      → family
//   lexilens_pro_monthly        → tier2  (RESERVED — not in 4.4 MVP)
//   lexilens_pro_yearly         → tier2  (RESERVED — not in 4.4 MVP)
//
// We also accept `_annual` as a synonym for `_yearly` for legacy / fallback
// reasons (RC dashboards sometimes still use "annual" terminology in the
// package identifier). If you ship product IDs that don't match these
// prefixes, this fallback returns 'tier1' for any active entitlement
// (safe paid-equivalent).

function tierFromProductId(productId: string | null): SubscriptionDetails["tier"] {
  if (!productId) return "free";
  const id = productId.toLowerCase();
  if (id.includes("family")) return "family";
  if (id.includes("pro"))    return "tier2";
  if (
    id.includes("premium") ||
    id.includes("monthly") ||
    id.includes("yearly") ||
    id.includes("annual")
  ) {
    return "tier1";
  }
  // Unknown product but entitlement is active → default to tier1 (paid-equiv).
  return "tier1";
}

// ─── Derivation from CustomerInfo ─────────────────────────────────────────

export function deriveSubscriptionDetails(info: CustomerInfo | null): SubscriptionDetails {
  if (!info) return FREE_SUBSCRIPTION;

  const ent = info.entitlements?.active?.[ENTITLEMENT_PREMIUM];
  if (!ent) return FREE_SUBSCRIPTION;

  const expirationDate = ent.expirationDate ? new Date(ent.expirationDate).getTime() : null;

  return {
    isActive:       ent.isActive === true,
    productId:      ent.productIdentifier ?? null,
    willRenew:      ent.willRenew === true,
    expirationDate,
    managementUrl:  info.managementURL ?? null,
    tier:           tierFromProductId(ent.productIdentifier ?? null),
    // `periodType` is 'INTRO' or 'TRIAL' during free-trial / intro-price windows.
    inGracePeriod:  ent.periodType === "INTRO" || ent.periodType === "TRIAL",
  };
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Initialize RevenueCat. Idempotent — safe to call multiple times. Calling
 * after a previous successful init with a different `appUserId` triggers
 * a logIn() to switch users.
 *
 * Returns true if RC is usable after this call, false otherwise. Never throws.
 */
export async function initRevenueCat(opts?: { appUserId?: string }): Promise<boolean> {
  // Already configured — just update appUserId if it differs.
  if (_configured) {
    if (opts?.appUserId && opts.appUserId !== _identifiedUserId) {
      await identifyParent(opts.appUserId);
    }
    return true;
  }

  // Dev-mode guard. See module-level comment for context.
  if (__DEV__) {
    console.log(
      "[revenueCat] Skipping init in __DEV__ (Metro HMR + RC log handler crash workaround). " +
      "Test paywall in EAS preview/staging builds.",
    );
    return false;
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn(
      `[revenueCat] No API key for platform=${Platform.OS}. ` +
      `Paywall + purchases disabled this session.`,
    );
    addGameBreadcrumb({
      category: "revenuecat",
      message:  "init skipped — no API key",
      data:     { platform: Platform.OS },
    });
    return false;
  }

  const mod = await loadPurchases();
  if (!mod) return false;

  try {
    const Purchases = mod.default;
    // WARN level is recommended for production. Set ERROR if RC is too chatty.
    Purchases.setLogLevel(mod.LOG_LEVEL.WARN);

    if (opts?.appUserId) {
      await Purchases.configure({ apiKey, appUserID: opts.appUserId });
      _identifiedUserId = opts.appUserId;
    } else {
      await Purchases.configure({ apiKey });
    }

    _configured = true;
    attachNativeListener(mod);

    addGameBreadcrumb({
      category: "revenuecat",
      message:  "Configured",
      data:     { hasUserId: !!opts?.appUserId, platform: Platform.OS },
    });
    return true;
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: "revenueCat", phase: "configure" },
    });
    return false;
  }
}

/**
 * Switch the RC-tracked user. Call after Supabase auth resolves so the
 * Supabase parent UUID is the RC app_user_id. Idempotent if the userId
 * hasn't changed.
 */
export async function identifyParent(parentId: string): Promise<void> {
  if (!_configured) {
    // initRevenueCat will pick this up.
    await initRevenueCat({ appUserId: parentId });
    return;
  }
  if (_identifiedUserId === parentId) return;

  const mod = await loadPurchases();
  if (!mod) return;

  try {
    await mod.default.logIn(parentId);
    _identifiedUserId = parentId;
    addGameBreadcrumb({
      category: "revenuecat",
      message:  "Identified",
      data:     { parentId },
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: "revenueCat", phase: "logIn" },
    });
  }
}

/**
 * Clear identity (e.g. on Supabase sign-out). Future purchases will use an
 * anonymous RC ID until the next identifyParent() call.
 */
export async function clearParent(): Promise<void> {
  if (!_configured) return;
  const mod = await loadPurchases();
  if (!mod) return;
  try {
    await mod.default.logOut();
    _identifiedUserId = null;
    addGameBreadcrumb({ category: "revenuecat", message: "Logged out" });
  } catch (err) {
    // logOut on anonymous user throws; not actionable, swallow.
    if (__DEV__) console.warn("[revenueCat] logOut:", err);
  }
}

/**
 * Returns the current offering's available packages, or null if RC is
 * unavailable / no current offering is configured in the RC Dashboard.
 *
 * Render the returned packages in the paywall UI. Each package wraps a
 * StoreProduct with localized price, title, and intro-offer metadata.
 */
export async function fetchCurrentOffering(): Promise<PurchasesOffering | null> {
  if (!_configured) return null;
  const mod = await loadPurchases();
  if (!mod) return null;
  try {
    const offerings = await mod.default.getOfferings();
    return offerings.current ?? null;
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: "revenueCat", phase: "getOfferings" },
    });
    return null;
  }
}

export type PurchaseOutcome =
  | { kind: "success";   customerInfo: CustomerInfo; details: SubscriptionDetails }
  | { kind: "cancelled" }
  | { kind: "error";     message: string };

/**
 * Purchase a package. Returns a discriminated outcome instead of throwing.
 * Caller renders the appropriate UI for each kind.
 */
export async function purchasePackage(pkg: PurchasesPackage): Promise<PurchaseOutcome> {
  if (!_configured) {
    return { kind: "error", message: "RevenueCat is not configured." };
  }
  const mod = await loadPurchases();
  if (!mod) return { kind: "error", message: "RevenueCat SDK unavailable." };

  try {
    addGameBreadcrumb({
      category: "revenuecat",
      message:  "Purchase initiated",
      data:     { productId: pkg.product.identifier },
    });
    const { customerInfo } = await mod.default.purchasePackage(pkg);
    const details = deriveSubscriptionDetails(customerInfo);
    addGameBreadcrumb({
      category: "revenuecat",
      message:  "Purchase succeeded",
      data:     { productId: pkg.product.identifier, tier: details.tier },
    });
    return { kind: "success", customerInfo, details };
  } catch (err: any) {
    // RC throws with `userCancelled: true` for user-initiated cancels.
    if (err?.userCancelled === true) {
      addGameBreadcrumb({
        category: "revenuecat",
        message:  "Purchase cancelled",
        data:     { productId: pkg.product.identifier },
      });
      return { kind: "cancelled" };
    }
    Sentry.captureException(err, {
      tags: { component: "revenueCat", phase: "purchasePackage" },
      extra: { productId: pkg.product.identifier },
    });
    return {
      kind:    "error",
      message: err?.message ?? "Purchase failed. Please try again.",
    };
  }
}

/**
 * Restore previous purchases. Useful for parents who reinstall or sign in
 * on a new device. Returns the resulting customer info; null on failure.
 */
export async function restorePurchases(): Promise<{
  customerInfo: CustomerInfo;
  details:      SubscriptionDetails;
} | null> {
  if (!_configured) return null;
  const mod = await loadPurchases();
  if (!mod) return null;
  try {
    addGameBreadcrumb({ category: "revenuecat", message: "Restore initiated" });
    const customerInfo = await mod.default.restorePurchases();
    const details = deriveSubscriptionDetails(customerInfo);
    addGameBreadcrumb({
      category: "revenuecat",
      message:  "Restore completed",
      data:     { tier: details.tier, isActive: details.isActive },
    });
    return { customerInfo, details };
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: "revenueCat", phase: "restorePurchases" },
    });
    return null;
  }
}

/**
 * Read the current CustomerInfo from RC's cache. Triggers a fresh fetch
 * from RC's backend on first call after configure(). Subsequent calls
 * return the cached value updated by the listener.
 */
export async function getCustomerInfo(): Promise<{
  customerInfo: CustomerInfo;
  details:      SubscriptionDetails;
} | null> {
  if (!_configured) return null;
  const mod = await loadPurchases();
  if (!mod) return null;
  try {
    const customerInfo = await mod.default.getCustomerInfo();
    return { customerInfo, details: deriveSubscriptionDetails(customerInfo) };
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: "revenueCat", phase: "getCustomerInfo" },
    });
    return null;
  }
}

// ─── Listener fanout ──────────────────────────────────────────────────────

function attachNativeListener(mod: typeof import("react-native-purchases")): void {
  if (_nativeListenerAttached) return;
  try {
    mod.default.addCustomerInfoUpdateListener((info: CustomerInfo) => {
      for (const fn of _infoListeners) {
        try { fn(info); } catch (e) {
          // Don't let one bad listener kill the rest.
          console.warn("[revenueCat] listener threw:", e);
        }
      }
    });
    _nativeListenerAttached = true;
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: "revenueCat", phase: "addCustomerInfoUpdateListener" },
    });
  }
}

/**
 * Subscribe to customer-info updates from RC. Returns an unsubscribe fn.
 *
 * Use this in gameStore (or a hook) to refresh `parentSubscriptionTier`
 * whenever RC notifies of a purchase / renewal / expiration / refund.
 */
export function addCustomerInfoListener(cb: InfoListener): () => void {
  _infoListeners.add(cb);
  return () => { _infoListeners.delete(cb); };
}

/** True iff this RC instance has been successfully configured. */
export function isConfigured(): boolean {
  return _configured;
}
