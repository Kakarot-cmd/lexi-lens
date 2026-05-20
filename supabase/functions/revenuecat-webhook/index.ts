/**
 * supabase/functions/revenuecat-webhook/index.ts
 * Lexi-Lens — RevenueCat webhook handler (Phase 4.4).
 *
 * POST /functions/v1/revenuecat-webhook
 *
 * What this function does
 * ───────────────────────
 * Receives RevenueCat server-to-server notifications and updates two
 * columns on `public.parents`:
 *   • subscription_tier        — authoritative entitlement state.
 *   • subscription_expires_at  — server-side mirror of RC's expiration
 *                                (or grace-period end during a billing
 *                                issue). Read by parent_has_premium()
 *                                and the quests RLS tier gate for inline
 *                                self-heal: any feature gate auto-revokes
 *                                a lapsed parent the instant their event
 *                                fails to arrive, rather than waiting on
 *                                a (potentially delayed) EXPIRATION
 *                                webhook.
 *
 * Server-side enforcement (Edge Functions, RLS policies) only trusts
 * these two columns, not the client's read of RC.
 *
 * Requires migration 20260520_subscription_expires_self_heal.sql
 * (deploy migration FIRST, then this function). Without the column the
 * UPDATE will 500 and RC will retry — the safe direction.
 *
 * Security model
 * ──────────────
 * 1. Authorization header MUST match REVENUECAT_WEBHOOK_SECRET (a shared
 *    secret you configure both in the RC Dashboard and as a Supabase Edge
 *    Function secret). Bearer token format: `Authorization: Bearer <secret>`.
 *    Without this, anyone can POST and grant themselves paid tier.
 *
 * 2. The function uses SERVICE_ROLE_KEY to bypass RLS — it must update rows
 *    in `public.parents` regardless of who is signed in (the webhook isn't
 *    signed in as anyone).
 *
 * 3. We deploy with `--no-verify-jwt` because RC's request isn't a
 *    Supabase-signed JWT. We rely on the shared-secret bearer instead.
 *
 * Idempotency
 * ───────────
 * RC may retry on transient errors. The `revenuecat_webhook_log` table
 * (migration 20260514) records every processed event_id. We check before
 * applying state changes and short-circuit on duplicates.
 *
 * Ordering guard (20260518)
 * ─────────────────────────
 * RC does NOT guarantee webhook delivery order and this function runs as
 * concurrent Edge invocations. Without a guard, a late-delivered RENEWAL
 * can overwrite a freshly-applied EXPIRATION (re-granting paid access to
 * a lapsed user) purely on write-race luck. Each write records RC's
 * source-side `event.event_timestamp_ms` into
 * `parents.last_rc_event_ts_ms`, and an incoming event is applied ONLY IF
 * its event_timestamp_ms >= the stored watermark. NULL watermark = first
 * event, always applied. The guard also protects subscription_expires_at:
 * a stale BILLING_ISSUE cannot push expires_at backwards over a newer
 * RENEWAL's longer horizon.
 *
 * Event handling
 * ──────────────
 * Mapped events (entitlement gained → set tier=paid, write expires_at):
 *   • INITIAL_PURCHASE
 *   • RENEWAL
 *   • PRODUCT_CHANGE
 *   • UNCANCELLATION
 *   • TEMPORARY_ENTITLEMENT_GRANT   (RC promotional grant)
 *   • SUBSCRIPTION_EXTENDED         (apple grace period extension)
 *
 * Entitlement lost → set tier='free', write expires_at as last-known:
 *   • EXPIRATION
 *   • REFUND
 *   • SUBSCRIPTION_PAUSED           (Android only)
 *
 * Grace extension → keep tier, push expires_at forward to grace end:
 *   • BILLING_ISSUE                 (auto-renewal failed; entitlement
 *                                    holds until grace_period_expiration_at_ms.
 *                                    See RC docs "Billing Issues & Grace
 *                                    Periods".)
 *
 * Special handling:
 *   • CANCELLATION — user cancelled but entitlement remains until expiration.
 *     We DO NOT change tier or expires_at here; we wait for EXPIRATION.
 *   • TRANSFER — RC moves the entitlement to a different app_user_id.
 *     We update the OLD app_user_id to free and (if known) set the NEW one
 *     to the active tier with the transferred expiration.
 *
 * Ignored events (no write at all):
 *   • TEST                          (RC dashboard "Send test event" button)
 *   • NON_RENEWING_PURCHASE         (consumables — no entitlement state)
 *   • CANCELLATION                  (wait for EXPIRATION; see above)
 *   • BILLING_ISSUE with no grace   (Stripe path / grace-not-configured on
 *                                    store; the imminent EXPIRATION handles
 *                                    revocation instead)
 *
 * Forward compatibility: unknown event types are logged + returned 200 so
 * RC doesn't retry. New event types are added to the mapped sets above as
 * RC introduces them.
 *
 * Tier mapping (entitlement product → schema tier)
 * ────────────────────────────────────────────────
 * Same as client (lib/revenueCat.ts:tierFromProductId). If you change
 * product IDs in App Store Connect / Play Console, update BOTH places.
 *
 * Deploy
 * ──────
 *   supabase functions deploy revenuecat-webhook --no-verify-jwt
 *
 * Secrets required:
 *   supabase secrets set REVENUECAT_WEBHOOK_SECRET=<shared-secret>
 *
 * RC Dashboard:
 *   Project Settings → Integrations → Webhooks → Add webhook
 *     URL:     https://<project-ref>.supabase.co/functions/v1/revenuecat-webhook
 *     Headers: Authorization: Bearer <same-shared-secret>
 *
 * Store-side prerequisite (cross-platform)
 * ────────────────────────────────────────
 * For grace handling to do anything at all, grace periods MUST be enabled
 * in BOTH stores:
 *   • App Store Connect → Subscriptions → (each group) → Billing Grace
 *     Period (Apple supports up to 16 weeks; 16 days is a sane default).
 *   • Google Play Console → Subscriptions → (each subscription) → Account
 *     hold and grace period (Google supports 3, 7, 14, 30 days).
 * Without these, RC delivers BILLING_ISSUE with grace_period_expiration_at_ms
 * = null, which this function treats the same as ignore (tier stays, no
 * expires_at extension), and the user's EXPIRATION arrives essentially
 * simultaneously. Functionally OK either way; configuring grace just buys
 * paying users a recovery window.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

// ─── Type helpers ─────────────────────────────────────────────────────────
//
// Why this exists: @supabase/supabase-js v2's exported types have
// tightened across minor versions. `ReturnType<typeof createClient>`
// (the obvious choice for typing a passed-in client) now resolves to
// `SupabaseClient<unknown, ..., never, never, ...>` because the declared
// signature defaults `Database = unknown`, which collapses every schema
// param to `never`. But the runtime client returned by
// `createClient(url, key)` is `SupabaseClient<any, "public", "public",
// any, any>`. Passing the runtime client into a helper typed against
// the declared signature fails `deno check` even though it works fine
// at runtime, and every `.from(...).update(...)` chain inside the
// helper inherits `never` so the body fails too.
//
// We're not doing inference-heavy chained ops inside markProcessed or
// handleTransfer, so widening to `any` is the honest type. This is the
// same effective looseness the file had before the v2 minor bump.
// Tighten this if/when we adopt a typed `Database` schema across the
// whole repo (out of scope for this change).
//
// deno-lint-ignore no-explicit-any
type DbClient = any;

// Must match `ENTITLEMENT_PREMIUM` in lib/revenueCat.ts.
const ENTITLEMENT_ID = "premium";

// Event-type sets — keep in sync with the doc block above.
const EVENTS_GRANT_TIER = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "PRODUCT_CHANGE",
  "UNCANCELLATION",
  "TEMPORARY_ENTITLEMENT_GRANT",
  "SUBSCRIPTION_EXTENDED",
]);

const EVENTS_REVOKE_TIER = new Set([
  "EXPIRATION",
  "REFUND",
  "SUBSCRIPTION_PAUSED",
]);

// Extend entitlement via grace period — no tier change, push expires_at
// to grace_period_expiration_at_ms so the inline self-heal in
// parent_has_premium() doesn't incorrectly revoke a card-decline-then-
// retry-succeeds user. Stays a no-op when grace is null (see flow below).
const EVENTS_EXTEND_GRACE = new Set([
  "BILLING_ISSUE",
]);

const EVENTS_IGNORE = new Set([
  "TEST",
  "NON_RENEWING_PURCHASE",
  "CANCELLATION",   // wait for EXPIRATION — entitlement remains until then
]);

// ─── Tier mapping ─────────────────────────────────────────────────────────
//
// EXPLICIT ALLOWLIST (replaces prior substring matcher 2026-05-20).
//
// History: prior implementation used `id.includes("family")` /
// `id.includes("pro")` checks. Verified bug on 2026-05-20: the product_id
// `test_product` matched `"pro"` (inside `"product"`) and routed to
// tier2. No corruption resulted because those events were filtered out by
// event type earlier, but the silent-collision risk was real for any
// future SKU containing those substrings (promo SKUs, typos, RC product
// renames). The allowlist below makes every routing decision explicit.
//
// Fail-closed default: unknown product_id → "free". Better to under-grant
// (and notice when the user complains) than silently grant the wrong tier
// (which the user thanks us for and we never catch).
//
// Adding a new product:
//   1. Create it in App Store Connect / Play Console.
//   2. Add it to PRODUCT_TIER_MAP below.
//   3. Mirror the same change in lib/revenueCat.ts:tierFromProductId.
//
// Play formats product IDs as "base_product_id:base_plan_id". Apple uses
// the bare product_id. We split on ":" and key on the base so both
// platforms hit the same map entry.

const PRODUCT_TIER_MAP: Record<string, "tier1" | "tier2" | "family"> = {
  // Tier 1 — current premium products (Android Play + iOS App Store)
  "lexilens_premium_monthly":    "tier1",
  "lexilens_premium_annual":     "tier1",
  "lexilens_premium_annual_v2":  "tier1",  // iOS rename (per memory)

  // Family — planned (per roadmap)
  "lexilens_family_yearly":      "family",

  // Tier 2 — placeholder slot (no products yet); add here when created.
  // Example shape:
  //   "lexilens_pro_monthly": "tier2",
  //   "lexilens_pro_annual":  "tier2",
};

function tierFromProductId(productId: string | null | undefined): "free" | "tier1" | "tier2" | "family" {
  if (!productId) return "free";

  // Strip the Play ":base_plan_id" suffix (no-op on Apple product_ids).
  const baseProductId = productId.split(":")[0].toLowerCase();

  return PRODUCT_TIER_MAP[baseProductId] ?? "free";
}

/** Safely convert an RC `*_at_ms` epoch field to ISO-8601, or null. */
function msToIso(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  // RC uses ms epoch; Postgres timestamptz round-trips through ISO.
  return new Date(ms).toISOString();
}

// ─── Handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // ── 1. Authorization: shared bearer secret ─────────────────────────────
  const expectedSecret = Deno.env.get("REVENUECAT_WEBHOOK_SECRET");
  if (!expectedSecret) {
    console.error("[revenuecat-webhook] REVENUECAT_WEBHOOK_SECRET not set");
    return jsonResponse({ error: "Webhook secret not configured server-side" }, 500);
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const provided   = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!provided || !timingSafeEqual(provided, expectedSecret)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // ── 2. Parse + validate body ───────────────────────────────────────────
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const event = payload?.event;
  if (!event || typeof event.type !== "string" || typeof event.id !== "string") {
    return jsonResponse({ error: "Missing event.id or event.type" }, 400);
  }

  const eventId      = event.id;
  const eventType    = event.type;
  const appUserId    = event.app_user_id as string | undefined;
  const productId    = event.product_id  as string | undefined;
  const expiresMs    = event.expiration_at_ms as number | undefined;
  // Only present (non-null) on BILLING_ISSUE when the store has grace
  // configured. Null for Stripe events and for stores without grace.
  const graceMs      = event.grace_period_expiration_at_ms as number | undefined;
  // RC's authoritative source-side time for when this event occurred.
  // Present on every event type; monotonic per subscription from RC. Used
  // as the ordering guard key (see header / 20260518).
  const eventTsMsRaw = event.event_timestamp_ms;
  const eventTsMs    = typeof eventTsMsRaw === "number" && Number.isFinite(eventTsMsRaw)
    ? eventTsMsRaw
    : null;

  console.log(`[revenuecat-webhook] ${eventType} id=${eventId} user=${appUserId ?? "(none)"} product=${productId ?? "(none)"}`);

  // ── 3. Connect to DB with service role ─────────────────────────────────
  const supabaseUrl     = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("[revenuecat-webhook] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return jsonResponse({ error: "Server misconfigured" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── 4. Idempotency check ───────────────────────────────────────────────
  // Insert a row pre-emptively; on conflict we know this event was already
  // processed and can short-circuit.
  const { data: logRow, error: logErr } = await supabase
    .from("revenuecat_webhook_log")
    .upsert(
      {
        event_id:    eventId,
        event_type:  eventType,
        app_user_id: appUserId ?? null,
        product_id:  productId ?? null,
        raw_payload: payload,
      },
      { onConflict: "event_id", ignoreDuplicates: true },
    )
    .select("event_id, processed_at")
    .maybeSingle();

  if (logErr) {
    console.error("[revenuecat-webhook] Failed to insert log row:", logErr);
    // Don't return 500 — RC will retry, possibly duplicating processing.
    // We continue with best-effort. If the DB is genuinely down, the next
    // statement will fail too and we'll return 500 there.
  }

  // upsert with ignoreDuplicates returns null on conflict. If null → duplicate.
  if (!logRow && !logErr) {
    console.log(`[revenuecat-webhook] Skipping duplicate event ${eventId}`);
    return jsonResponse({ ok: true, duplicate: true });
  }

  // ── 5. Apply state change based on event type ──────────────────────────
  if (EVENTS_IGNORE.has(eventType)) {
    await markProcessed(supabase, eventId, "ignored");
    return jsonResponse({ ok: true, ignored: true });
  }

  if (!appUserId) {
    console.warn(`[revenuecat-webhook] No app_user_id on event ${eventId}; cannot map to parent`);
    await markProcessed(supabase, eventId, "no_user");
    return jsonResponse({ ok: true, no_user: true });
  }

  // RC's app_user_id is the Supabase parent UUID (set by Purchases.logIn in
  // lib/revenueCat.ts:identifyParent). Validate that it parses as a UUID.
  if (!isValidUUID(appUserId)) {
    console.warn(`[revenuecat-webhook] app_user_id ${appUserId} is not a UUID — likely anonymous RC ID. Skipping.`);
    await markProcessed(supabase, eventId, "anonymous_user");
    return jsonResponse({ ok: true, anonymous: true });
  }

  // Special case: TRANSFER moves entitlement between users.
  if (eventType === "TRANSFER") {
    const transferredFrom = event.transferred_from as string[] | undefined;
    const transferredTo   = event.transferred_to   as string[] | undefined;
    return handleTransfer(supabase, eventId, transferredFrom, transferredTo, productId, expiresMs, eventTsMs);
  }

  // ── 5a. Decide what to write ───────────────────────────────────────────
  //
  // Three branches, mutually exclusive:
  //   • EVENTS_GRANT_TIER   → write {tier, expires_at}
  //   • EVENTS_REVOKE_TIER  → write {tier='free', expires_at as last-known}
  //   • EVENTS_EXTEND_GRACE → write {expires_at = grace end}; no tier change.
  //                           If grace is null, fall through to a no-op
  //                           (functionally an ignore — the imminent
  //                           EXPIRATION handles it).
  //
  // Any other event type is unknown — log and 200 so RC doesn't retry.

  let newTier: "free" | "tier1" | "tier2" | "family" | null = null;  // null = unchanged
  let newExpiresAtIso: string | null = null;                          // null = unchanged

  if (EVENTS_GRANT_TIER.has(eventType)) {
    newTier         = tierFromProductId(productId);
    newExpiresAtIso = msToIso(expiresMs);
  } else if (EVENTS_REVOKE_TIER.has(eventType)) {
    newTier         = "free";
    newExpiresAtIso = msToIso(expiresMs);   // last-known expiration; OK if past
  } else if (EVENTS_EXTEND_GRACE.has(eventType)) {
    const graceIso = msToIso(graceMs);
    if (graceIso === null) {
      // No grace from RC (Stripe path or grace not configured on the
      // store). Effectively an ignore: the imminent EXPIRATION will
      // revoke. Logging it so we can spot mis-configured grace later.
      console.log(`[revenuecat-webhook] BILLING_ISSUE for ${appUserId} arrived without grace_period_expiration_at_ms — treating as ignore.`);
      await markProcessed(supabase, eventId, "billing_issue_no_grace");
      return jsonResponse({ ok: true, billing_issue: true, grace: false });
    }
    newExpiresAtIso = graceIso;
    // newTier left null → tier column not in update payload.
  } else {
    console.warn(`[revenuecat-webhook] Unknown event type: ${eventType}. Treating as no-op.`);
    await markProcessed(supabase, eventId, "unknown_type");
    return jsonResponse({ ok: true, unknown: true });
  }

  // ── 5b. Defensive read + ordering guard ────────────────────────────────
  const { data: parentRow } = await supabase
    .from("parents")
    .select("subscription_tier, last_rc_event_ts_ms")
    .eq("id", appUserId)
    .maybeSingle();

  if (!parentRow) {
    console.warn(`[revenuecat-webhook] No parent row for ${appUserId} — RC user not in parents table. Skipping.`);
    await markProcessed(supabase, eventId, "no_parent_row");
    return jsonResponse({ ok: true, no_parent: true });
  }

  // For GRANT events with an expiration in the past, treat as revoke.
  if (EVENTS_GRANT_TIER.has(eventType) && expiresMs && expiresMs < Date.now()) {
    newTier = "free";
    // newExpiresAtIso already set to the (past) expiresMs above; correct.
  }

  // Ordering guard (20260518). Skip if this event is OLDER than the last
  // event already applied to this parent. Out-of-order / racing webhook
  // deliveries must not let a stale event clobber a newer one. NULL
  // watermark = nothing applied yet → always apply. Missing
  // event_timestamp_ms (shouldn't happen on real RC events) → fail OPEN.
  const priorTsMs = parentRow.last_rc_event_ts_ms as number | null;
  if (eventTsMs !== null && priorTsMs !== null && eventTsMs < priorTsMs) {
    console.log(
      `[revenuecat-webhook] Stale event ${eventId} (${eventType}) for ${appUserId}: ` +
      `event_ts=${eventTsMs} < applied_ts=${priorTsMs}. Skipping write.`,
    );
    await markProcessed(supabase, eventId, "stale_skipped", newTier ?? parentRow.subscription_tier);
    return jsonResponse({ ok: true, stale: true, tier: parentRow.subscription_tier });
  }

  // ── 5c. Build payload + apply ──────────────────────────────────────────
  // Advance the watermark in the SAME statement so the tier and its
  // ordering key move atomically (one row, one lock). Only advance the
  // watermark when we actually have a newer timestamp; never move it
  // backwards.
  const updatePayload: {
    subscription_tier?:       string;
    subscription_expires_at?: string;
    last_rc_event_ts_ms?:     number;
  } = {};

  if (newTier !== null) {
    updatePayload.subscription_tier = newTier;
  }
  if (newExpiresAtIso !== null) {
    updatePayload.subscription_expires_at = newExpiresAtIso;
  }
  if (eventTsMs !== null && (priorTsMs === null || eventTsMs >= priorTsMs)) {
    updatePayload.last_rc_event_ts_ms = eventTsMs;
  }

  // Sanity: if we have nothing to write (e.g. EXTEND_GRACE with no grace
  // that somehow slipped past the early-return above), don't issue an
  // empty UPDATE.
  if (Object.keys(updatePayload).length === 0) {
    await markProcessed(supabase, eventId, "no_change");
    return jsonResponse({ ok: true, no_change: true });
  }

  const { error: updErr } = await supabase
    .from("parents")
    .update(updatePayload)
    .eq("id", appUserId);

  if (updErr) {
    console.error(`[revenuecat-webhook] Failed to update parent ${appUserId}:`, updErr);
    // Return 500 so RC retries. The idempotency log row will protect against
    // double-application on retry.
    return jsonResponse({ error: "Update failed", details: updErr.message }, 500);
  }

  const appliedStatus = EVENTS_EXTEND_GRACE.has(eventType) ? "grace_extended" : "applied";
  await markProcessed(supabase, eventId, appliedStatus, newTier ?? parentRow.subscription_tier);

  console.log(
    `[revenuecat-webhook] ${appliedStatus} ` +
    `tier=${newTier ?? "(unchanged:" + parentRow.subscription_tier + ")"} ` +
    `expires_at=${newExpiresAtIso ?? "(unchanged)"} ` +
    `for parent=${appUserId}`,
  );
  return jsonResponse({
    ok: true,
    tier: newTier ?? parentRow.subscription_tier,
    expires_at: newExpiresAtIso,
    grace_extended: EVENTS_EXTEND_GRACE.has(eventType),
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────

async function markProcessed(
  supabase: DbClient,
  eventId:  string,
  status:   string,
  appliedTier?: string | null,
): Promise<void> {
  await supabase
    .from("revenuecat_webhook_log")
    .update({
      processed_at:    new Date().toISOString(),
      processing_note: appliedTier ? `${status}:${appliedTier}` : status,
    })
    .eq("event_id", eventId);
}

async function handleTransfer(
  supabase:  DbClient,
  eventId:   string,
  fromIds:   string[] | undefined,
  toIds:     string[] | undefined,
  productId: string | undefined,
  expiresMs: number | undefined,
  eventTsMs: number | null,
): Promise<Response> {
  const tier       = tierFromProductId(productId);
  const expiresIso = msToIso(expiresMs);

  // Per-row ordering guard: only mutate a parent if this TRANSFER is not
  // older than the event already applied to that parent. Done per-id
  // (can't bulk .in() update with a per-row timestamp comparison via the
  // JS client, so we resolve the eligible id sets first).
  async function eligibleIds(ids: string[]): Promise<string[]> {
    const valid = ids.filter(isValidUUID);
    if (valid.length === 0) return [];
    if (eventTsMs === null) return valid; // no event time → fail open
    const { data } = await supabase
      .from("parents")
      .select("id, last_rc_event_ts_ms")
      .in("id", valid);
    if (!data) return [];
    return (data as { id: string; last_rc_event_ts_ms: number | null }[])
      .filter((r) => r.last_rc_event_ts_ms === null || eventTsMs >= r.last_rc_event_ts_ms)
      .map((r) => r.id);
  }

  const tsPatch = eventTsMs !== null ? { last_rc_event_ts_ms: eventTsMs } : {};

  // Revoke from old users. Leave subscription_expires_at as last-known
  // (tier='free' is the gate; expires_at remains as historical record).
  if (fromIds && fromIds.length > 0) {
    const ids = await eligibleIds(fromIds);
    if (ids.length > 0) {
      await supabase
        .from("parents")
        .update({ subscription_tier: "free", ...tsPatch })
        .in("id", ids);
    }
  }

  // Grant to new users with the transferred expiration (if RC supplied one).
  if (toIds && toIds.length > 0) {
    const ids = await eligibleIds(toIds);
    if (ids.length > 0) {
      const grantPatch: Record<string, unknown> = {
        subscription_tier: tier,
        ...tsPatch,
      };
      if (expiresIso) grantPatch.subscription_expires_at = expiresIso;
      await supabase
        .from("parents")
        .update(grantPatch)
        .in("id", ids);
    }
  }

  await markProcessed(supabase, eventId, "transfer", tier);
  return jsonResponse({ ok: true, transfer: true, tier });
}

/**
 * Constant-time string comparison. Standard `===` leaks length / prefix
 * information via timing side channels — relevant when an attacker is
 * brute-forcing the webhook secret.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still run a fixed-time loop so length-mismatch doesn't itself leak.
    let _ = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) _ |= 1;
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isValidUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
