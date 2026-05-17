/**
 * revenuecatWebhook.ts — pure-logic extract of:
 *   • supabase/functions/revenuecat-webhook/index.ts → tierFromProductId
 *
 * Verbatim mirror as of repo 3ed6a1b. This single function decides
 * whether a paying customer gets unlocked. Given the asymmetric Product
 * IDs in this project (lexilens_premium_annual_v2 on Apple,
 * lexilens_premium_annual:annual on Google, monthly-v2, etc.), a silent
 * mis-map here = lost revenue that never throws an error. Highest-value
 * untested surface in the codebase. Platform-agnostic (server-side).
 */

export function tierFromProductId(
  productId: string | null | undefined,
): "free" | "tier1" | "tier2" | "family" {
  if (!productId) return "free";
  const id = productId.toLowerCase();
  if (id.includes("family")) return "family";
  if (id.includes("pro"))    return "tier2";
  return "tier1";
}
