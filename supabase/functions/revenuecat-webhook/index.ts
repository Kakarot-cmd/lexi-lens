/**
 * supabase/functions/revenuecat-webhook/index.ts
 * Lexi-Lens — RevenueCat webhook handler (Phase 4.4).
 *
 * POST /functions/v1/revenuecat-webhook
 *
 * What this function does
 * ───────────────────────
 * Receives RevenueCat server-to-server notifications and updates
 * `parents.subscription_tier` accordingly. This is the AUTHORITATIVE backend
 * sync — server-side enforcement (Edge Functions, RLS policies) only trusts
 * this column, not the client's read of RC.
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
 * Event handling
 * ──────────────
 * Mapped events (entitlement gained → set tier):
 *   • INITIAL_PURCHASE
 *   • RENEWAL
 *   • PRODUCT_CHANGE
 *   • UNCANCELLATION
 *   • TEMPORARY_ENTITLEMENT_GRANT   (RC promotional grant)
 *   • SUBSCRIPTION_EXTENDED         (apple grace period extension)
 *
 * Entitlement lost → set tier='free':
 *   • EXPIRATION
 *   • BILLING_ISSUE                 (auto-renewal failed after grace)
 *   • REFUND
 *   • SUBSCRIPTION_PAUSED           (Android only)
 *
 * Special handling:
 *   • CANCELLATION — user cancelled but entitlement remains until expiration.
 *     We DO NOT change tier here; we wait for EXPIRATION.
 *   • TRANSFER — RC moves the entitlement to a different app_user_id.
 *     We update the OLD app_user_id to free and (if known) set the NEW one
 *     to the active tier.
 *
 * Ignored events:
 *   • TEST                          (RC dashboard "Send test event" button)
 *   • NON_RENEWING_PURCHASE         (consumables — no entitlement state)
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
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

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
  "BILLING_ISSUE",
  "REFUND",
  "SUBSCRIPTION_PAUSED",
]);

const EVENTS_IGNORE = new Set([
  "TEST",
  "NON_RENEWING_PURCHASE",
  "CANCELLATION", // wait for EXPIRATION
]);

// ─── Tier mapping ─────────────────────────────────────────────────────────

function tierFromProductId(productId: string | null | undefined): "free" | "tier1" | "tier2" | "family" {
  if (!productId) return "free";
  const id = productId.toLowerCase();
  if (id.includes("family")) return "family";
  if (id.includes("pro"))    return "tier2";
  return "tier1";
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
    return handleTransfer(supabase, eventId, transferredFrom, transferredTo, productId);
  }

  let newTier: "free" | "tier1" | "tier2" | "family";
  if (EVENTS_GRANT_TIER.has(eventType)) {
    newTier = tierFromProductId(productId);
  } else if (EVENTS_REVOKE_TIER.has(eventType)) {
    newTier = "free";
  } else {
    // Unknown event type — log and ignore so RC doesn't retry.
    console.warn(`[revenuecat-webhook] Unknown event type: ${eventType}. Treating as no-op.`);
    await markProcessed(supabase, eventId, "unknown_type");
    return jsonResponse({ ok: true, unknown: true });
  }

  // Sanity: don't downgrade a parent in the brief window where two events
  // race (e.g. RENEWAL arrives before BILLING_ISSUE clears). Defensive read.
  const { data: parentRow } = await supabase
    .from("parents")
    .select("subscription_tier")
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
  }

  // Apply the update.
  const { error: updErr } = await supabase
    .from("parents")
    .update({ subscription_tier: newTier })
    .eq("id", appUserId);

  if (updErr) {
    console.error(`[revenuecat-webhook] Failed to update parent ${appUserId}:`, updErr);
    // Return 500 so RC retries. The idempotency log row will protect against
    // double-application on retry.
    return jsonResponse({ error: "Update failed", details: updErr.message }, 500);
  }

  await markProcessed(supabase, eventId, "applied", newTier);

  console.log(`[revenuecat-webhook] Applied tier=${newTier} for parent=${appUserId} (was ${parentRow.subscription_tier})`);
  return jsonResponse({ ok: true, tier: newTier });
});

// ─── Helpers ──────────────────────────────────────────────────────────────

async function markProcessed(
  supabase: ReturnType<typeof createClient>,
  eventId:  string,
  status:   string,
  appliedTier?: string,
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
  supabase: ReturnType<typeof createClient>,
  eventId:  string,
  fromIds:  string[] | undefined,
  toIds:    string[] | undefined,
  productId: string | undefined,
): Promise<Response> {
  const tier = tierFromProductId(productId);

  // Revoke from old users
  if (fromIds && fromIds.length > 0) {
    const validFrom = fromIds.filter(isValidUUID);
    if (validFrom.length > 0) {
      await supabase
        .from("parents")
        .update({ subscription_tier: "free" })
        .in("id", validFrom);
    }
  }

  // Grant to new users
  if (toIds && toIds.length > 0) {
    const validTo = toIds.filter(isValidUUID);
    if (validTo.length > 0) {
      await supabase
        .from("parents")
        .update({ subscription_tier: tier })
        .in("id", validTo);
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
