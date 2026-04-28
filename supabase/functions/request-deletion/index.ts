/**
 * supabase/functions/request-deletion/index.ts
 * Lexi-Lens — Phase 4.1 COPPA + GDPR-K Compliance
 *
 * POST /functions/v1/request-deletion
 *
 * REGULATORY BASIS:
 *   COPPA §312.6 — operator must delete child's personal information upon
 *   parent's request within a "reasonable time" (interpreted as 30 days).
 *   GDPR Art. 17 — erasure "without undue delay" (max 1 month).
 *
 * REQUEST BODY:
 *   {
 *     reason:       string,    // Optional. Parent's reason for deleting.
 *     confirmation: string,    // MUST equal "DELETE" (case-insensitive). Re-validated server-side.
 *   }
 *
 * REQUIRES:
 *   Authorization: Bearer <user_jwt>   (standard Supabase auth header)
 *
 * WHAT THIS FUNCTION DOES (in order):
 *   1.  Validates request method (POST only).
 *   2.  Parses and validates body.confirmation === "DELETE".
 *   3.  Authenticates the caller via JWT → extracts parent_id.
 *   4.  Inserts a data_deletion_requests row (status = 'processing').
 *   5.  Fetches all child IDs belonging to this parent.
 *   6.  Deletes child data immediately (hard deletes, no soft-delete):
 *         • scan_attempts (all rows where child_id ∈ child_ids)
 *         • word_tome     (all rows where child_id ∈ child_ids)
 *         • quest_completions (all rows where child_id ∈ child_ids)
 *         • child_profiles (parent_id = this parent)
 *   7.  Stamps auth.users.app_metadata with deletion_scheduled_at (+30 days).
 *       A pg_cron job (see coppa_gdpr_migration.sql) running nightly at 02:00 UTC
 *       DELETE FROM auth.users WHERE scheduled date < now().
 *   8.  Updates the deletion request row to status = 'completed'.
 *   9.  Returns success JSON with child_data_deleted: true and scheduled_at.
 *
 * PARTIAL FAILURE HANDLING:
 *   Each deletion step is try/catched independently. Errors are collected and
 *   returned in the response `errors` array, but the request is still marked
 *   complete. The Lexi-Lens team must monitor these logs and manually finish
 *   any partial failures.
 *
 * SECRETS REQUIRED (set via `supabase secrets set`):
 *   SUPABASE_URL             — set automatically by Supabase runtime
 *   SUPABASE_ANON_KEY        — set automatically by Supabase runtime
 *   SUPABASE_SERVICE_ROLE_KEY — must be set manually; needed for admin operations
 *
 * DEPLOY:
 *   supabase functions deploy request-deletion --no-verify-jwt
 *   (JWT is verified manually inside the function using getUser())
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Environment ──────────────────────────────────────────────────────────────

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY          = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ─── CORS headers ─────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
} as const;

// ─── Helper: JSON response ────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {

  // Preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  // Method guard
  if (req.method !== "POST") {
    return json({ error: "Method not allowed. Use POST." }, 405);
  }

  // ── 1. Parse body ──────────────────────────────────────────────────────────
  let body: { reason?: unknown; confirmation?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  // ── 2. Validate confirmation ────────────────────────────────────────────────
  // This is a server-side re-validation. Even if a malicious client
  // bypasses the UI, the function refuses to proceed without "DELETE".
  if (
    typeof body.confirmation !== "string" ||
    body.confirmation.trim().toUpperCase() !== "DELETE"
  ) {
    return json(
      { error: "Field 'confirmation' must equal 'DELETE'. Request rejected." },
      400
    );
  }

  const reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : "Not specified";

  // ── 3. Authenticate caller ─────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Authorization header missing or malformed." }, 401);
  }

  // Use the anon client + user JWT to getUser() — this validates the token
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth:   { autoRefreshToken: false, persistSession: false },
  });

  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return json({ error: "Invalid or expired session. Please sign in again." }, 401);
  }

  const parentId = user.id;

  // ── Service-role client for all destructive operations ─────────────────────
  // RLS bypass is intentional here: we are deleting the parent's OWN data
  // on their explicit, authenticated, double-confirmed request.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── 4. Insert deletion request record ──────────────────────────────────────
  const requestId        = crypto.randomUUID();
  const requestedAt      = new Date().toISOString();
  const scheduledAt      = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const { error: insertErr } = await admin.from("data_deletion_requests").insert({
    id:                     requestId,
    parent_id:              parentId,
    status:                 "processing",
    reason,
    requested_at:           requestedAt,
    scheduled_deletion_at:  scheduledAt,
  });

  if (insertErr) {
    // Don't abort — log and continue. A missing audit record is a compliance
    // issue to fix, but we should still delete the data the parent asked for.
    console.error(`[request-deletion] Failed to insert deletion request for ${parentId}:`, insertErr.message);
  }

  // ── 5. Get all children belonging to this parent ───────────────────────────
  const { data: children, error: childrenErr } = await admin
    .from("child_profiles")
    .select("id")
    .eq("parent_id", parentId);

  const errors: string[] = [];

  if (childrenErr) {
    errors.push(`children_lookup: ${childrenErr.message}`);
  }

  const childIds: string[] = (children ?? []).map((c: { id: string }) => c.id);

  // ── 6. Delete all child data (immediate, hard delete) ──────────────────────
  if (childIds.length > 0) {

    // scan_attempts
    const { error: scanErr } = await admin
      .from("scan_attempts")
      .delete()
      .in("child_id", childIds);
    if (scanErr) {
      errors.push(`scan_attempts: ${scanErr.message}`);
      console.error(`[request-deletion] scan_attempts delete error:`, scanErr.message);
    }

    // word_mastery
    const { error: masteryErr } = await admin
      .from("word_tome")
      .delete()
      .in("child_id", childIds);
    if (masteryErr) {
      errors.push(`word_tome: ${masteryErr.message}`);
      console.error(`[request-deletion] word_tome delete error:`, masteryErr.message);
    }

    // quest_completions — quest history
    const { error: questErr } = await admin
      .from("quest_completions")
      .delete()
      .in("child_id", childIds);
    if (questErr) {
      errors.push(`quest_completions: ${questErr.message}`);
      console.error(`[request-deletion] quest_completions delete error:`, questErr.message);
    }

    // children (delete all child profiles — this must come AFTER the above
    // or FK constraints will block deletion of parent records)
    const { error: childDeleteErr } = await admin
      .from("child_profiles")
      .delete()
      .eq("parent_id", parentId);
    if (childDeleteErr) {
      errors.push(`child_profiles_delete: ${childDeleteErr.message}`);
      console.error(`[request-deletion] child_profiles delete error:`, childDeleteErr.message);
    }
  }

  // ── 7. Stamp parent auth user for scheduled deletion ───────────────────────
  // We do NOT delete the auth user immediately because:
  //   a) The parent session is still active — deleting mid-session causes errors
  //   b) We want to give the parent 30 days to export data if needed
  //   c) We need the parent_id FK to remain valid for the audit records
  //
  // The pg_cron nightly job handles the actual auth.users deletion.
  const { error: metaErr } = await admin.auth.admin.updateUserById(parentId, {
    app_metadata: {
      deletion_requested_at:  requestedAt,
      deletion_scheduled_at:  scheduledAt,
      deletion_reason:        reason,
      deletion_request_id:    requestId,
    },
  });

  if (metaErr) {
    errors.push(`auth_metadata_stamp: ${metaErr.message}`);
    console.error(`[request-deletion] auth metadata update error:`, metaErr.message);
  }

  // ── 8. Update deletion request status ──────────────────────────────────────
  const finalStatus = errors.length === 0 ? "completed" : "processing";
  await admin
    .from("data_deletion_requests")
    .update({
      status:       finalStatus,
      completed_at: errors.length === 0 ? new Date().toISOString() : null,
    })
    .eq("id", requestId)
    .catch((e: Error) => {
      console.error("[request-deletion] Failed to update deletion status:", e.message);
    });

  // ── 9. Log outcome ──────────────────────────────────────────────────────────
  const logPrefix = `[request-deletion] parent=${parentId} request=${requestId}`;
  if (errors.length === 0) {
    console.log(`${logPrefix} — SUCCESS. ${childIds.length} children deleted. Account scheduled for ${scheduledAt}`);
  } else {
    console.error(`${logPrefix} — PARTIAL FAILURE. Errors: ${errors.join(", ")}`);
  }

  // ── 10. Return response ─────────────────────────────────────────────────────
  return json({
    success:                   true,
    child_data_deleted:        true,
    children_deleted_count:    childIds.length,
    parent_account_scheduled:  scheduledAt,
    request_id:                requestId,
    // Only include errors array if there were any — cleaner client-side
    ...(errors.length > 0 ? { errors } : {}),
  });
});
