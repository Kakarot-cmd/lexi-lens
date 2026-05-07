/**
 * supabase/functions/report-verdict/index.ts
 * Lexi-Lens — Phase 4.6 Compliance polish: in-app verdict reporting
 *
 * POST /functions/v1/report-verdict
 *
 * WHY AN EDGE FUNCTION (vs direct client INSERT under RLS)
 * ─────────────────────────────────────────────────────────
 * RLS would work for the simple authenticated-parent case, but we want to:
 *
 *   1. Cross-validate that the scan_attempt_id supplied by the client
 *      actually belongs to a child whose parent matches auth.uid(). RLS
 *      enforces parent_id on the new row, but it does NOT enforce that
 *      the scan_attempt_id refers to the parent's own scan — without this
 *      check, a malicious client could file reports against other
 *      households' scans, polluting our review queue.
 *   2. Stamp the row with app_variant + app_version derived from the
 *      request rather than trusting the client. Useful when triaging a
 *      spike to a single build.
 *   3. Forward a redacted copy to Sentry as a "warning" event so spikes
 *     surface in the same dashboard as crashes.
 *
 * The service role bypasses RLS but we re-implement the parent-ownership
 * check explicitly. Keep it simple — one SELECT, one INSERT, optional
 * Sentry breadcrumb (never blocks).
 *
 * REQUEST BODY
 *   {
 *     scanAttemptId: string,                 // required, FK to scan_attempts.id
 *     reason:        "wrong_object"          // required, one of the enum
 *                  | "wrong_property"
 *                  | "feels_inappropriate"
 *                  | "too_hard"
 *                  | "too_easy"
 *                  | "other",
 *     note?:         string,                 // optional, max 200 chars
 *     appVariant?:   "production"|"staging"|"development",
 *     appVersion?:   string,
 *   }
 *
 * RESPONSE
 *   200 { ok: true, reportId: string }
 *   400 { error: "Validation failed", details: string }
 *   401 { error: "Unauthorised" }
 *   403 { error: "Not your child's scan" }
 *   500 { error: "Insert failed" }
 *
 * SECURITY
 *   • Caller must present a valid Supabase JWT (verify_jwt = default true).
 *   • The JWT's auth.uid() is the parent_id stamped onto the row.
 *   • The scan_attempt is fetched via service role to confirm it belongs
 *     to a child whose parent_id matches auth.uid(). Any mismatch → 403.
 *
 * DEPLOY
 *   supabase functions deploy report-verdict
 *
 * REQUIRED SECRETS (auto-provided by Supabase runtime)
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_ANON_KEY            (for the JWT validator client)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const VALID_REASONS = new Set([
  "wrong_object",
  "wrong_property",
  "feels_inappropriate",
  "too_hard",
  "too_easy",
  "other",
]);

const VALID_VARIANTS = new Set(["production", "staging", "development"]);

const MAX_NOTE_CHARS = 200;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // ── 1. Parse + validate body ────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const scanAttemptId = body.scanAttemptId;
  const reason        = body.reason;
  const noteRaw       = body.note;
  const appVariantRaw = body.appVariant;
  const appVersionRaw = body.appVersion;

  if (typeof scanAttemptId !== "string" || scanAttemptId.length < 8) {
    return jsonResponse({ error: "Validation failed", details: "scanAttemptId required" }, 400);
  }
  if (typeof reason !== "string" || !VALID_REASONS.has(reason)) {
    return jsonResponse({ error: "Validation failed", details: "reason invalid" }, 400);
  }

  // Optional fields, sanitised.
  let note: string | null = null;
  if (typeof noteRaw === "string") {
    const trimmed = noteRaw.trim();
    note = trimmed.length === 0
      ? null
      : trimmed.slice(0, MAX_NOTE_CHARS);
  }

  const appVariant = typeof appVariantRaw === "string" && VALID_VARIANTS.has(appVariantRaw)
    ? appVariantRaw
    : null;

  const appVersion = typeof appVersionRaw === "string" && appVersionRaw.length <= 20
    ? appVersionRaw
    : null;

  // ── 2. Identify caller via JWT ──────────────────────────────────────────
  // verify_jwt = true (default) gates the function, but the JWT is also
  // available in the Authorization header so we can resolve auth.uid()
  // without needing a separate user-context client.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return jsonResponse({ error: "Unauthorised" }, 401);
  }

  // Use the anon key + the caller's JWT so getUser() returns the actual
  // signed-in parent, not service-role context.
  const userScoped = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: userData, error: userErr } = await userScoped.auth.getUser();
  if (userErr || !userData?.user?.id) {
    return jsonResponse({ error: "Unauthorised" }, 401);
  }
  const parentId = userData.user.id;

  // ── 3. Verify the scan_attempt belongs to one of this parent's children ─
  // Service role bypasses RLS so we can read the row regardless of who owns
  // it; we then verify the ownership ourselves. This is the critical
  // anti-spoofing check the RLS policy alone cannot enforce.
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: scanRow, error: scanErr } = await admin
    .from("scan_attempts")
    .select(`
      id,
      child_id,
      detected_label,
      resolved_name,
      cache_hit,
      child_profiles!inner ( id, parent_id )
    `)
    .eq("id", scanAttemptId)
    .single();

  if (scanErr || !scanRow) {
    // 403 not 404 — refusing to confirm the existence of unrelated rows.
    return jsonResponse({ error: "Not your child's scan" }, 403);
  }

  // child_profiles is a single nested row because we used !inner.
  const cp = (scanRow as { child_profiles: { id: string; parent_id: string } }).child_profiles;
  if (!cp || cp.parent_id !== parentId) {
    return jsonResponse({ error: "Not your child's scan" }, 403);
  }

  const childId       = cp.id;
  const detectedLabel = (scanRow as { detected_label: string | null }).detected_label;
  const resolvedName  = (scanRow as { resolved_name: string | null }).resolved_name;
  const cacheHit      = (scanRow as { cache_hit: boolean }).cache_hit;

  // ── 4. Insert the report ────────────────────────────────────────────────
  const { data: inserted, error: insertErr } = await admin
    .from("verdict_reports")
    .insert({
      scan_attempt_id: scanAttemptId,
      child_id:        childId,
      parent_id:       parentId,
      reason,
      note,
      detected_label:  detectedLabel,
      resolved_name:   resolvedName,
      cache_hit:       cacheHit,
      app_variant:     appVariant,
      app_version:     appVersion,
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    console.error("[report-verdict] Insert failed:", insertErr?.message);
    return jsonResponse({ error: "Insert failed" }, 500);
  }

  // ── 5. Done ─────────────────────────────────────────────────────────────
  // Sentry warning is fired on the CLIENT side (lib/sentry.ts →
  // captureVerdictReport). Doing it here would require the Sentry Deno
  // SDK and a separate DSN — duplicative for negligible benefit.
  console.log(
    `[report-verdict] reason=${reason} report=${inserted.id} scan=${scanAttemptId} cache=${cacheHit}`,
  );

  return jsonResponse({ ok: true, reportId: inserted.id });
});
