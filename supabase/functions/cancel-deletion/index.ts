/**
 * supabase/functions/cancel-deletion/index.ts
 * Lexi-Lens — Phase 4.1 COPPA + GDPR-K Compliance
 *
 * POST /functions/v1/cancel-deletion
 *
 * Called when a parent changes their mind within the 30-day window and
 * wants to keep their account. Clears the deletion_scheduled_at stamp
 * from auth.users.app_metadata so the pg_cron purge job ignores them,
 * and marks the data_deletion_requests row as 'cancelled'.
 *
 * REQUIRES:
 *   Authorization: Bearer <user_jwt>
 *
 * DEPLOY:
 *   supabase functions deploy cancel-deletion --no-verify-jwt
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
} as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return json({ error: "POST only" }, 405);

  // ── Authenticate ───────────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Authorization header missing." }, 401);
  }

  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: { headers: { Authorization: authHeader } },
      auth:   { autoRefreshToken: false, persistSession: false },
    }
  );

  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "Invalid session." }, 401);

  const parentId = user.id;

  // ── Service role for admin operations ──────────────────────────────────────
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // ── 1. Verify account is actually scheduled for deletion ───────────────────
  const { data: { user: fullUser } } = await admin.auth.admin.getUserById(parentId);
  const scheduledAt = fullUser?.app_metadata?.deletion_scheduled_at;

  if (!scheduledAt) {
    return json({ error: "No pending deletion found for this account." }, 400 );
  }

  // ── 2. Clear deletion metadata from auth.users ─────────────────────────────
  const { error: metaErr } = await admin.auth.admin.updateUserById(parentId, {
    app_metadata: {
      deletion_requested_at: null,
      deletion_scheduled_at: null,
      deletion_reason:       null,
      deletion_request_id:   null,
    },
  });

  if (metaErr) {
    console.error("[cancel-deletion] metadata clear failed:", metaErr.message);
    return json({ error: "Failed to cancel deletion. Try again." }, 500);
  }

  // ── 3. Mark the deletion request as cancelled ──────────────────────────────
  await admin
    .from("data_deletion_requests")
    .update({ status: "cancelled" })
    .eq("parent_id", parentId)
    .eq("status", "processing")
    .catch((e: Error) =>
      console.warn("[cancel-deletion] request row update failed:", e.message)
    );

  console.log(`[cancel-deletion] parent=${parentId} — deletion cancelled successfully`);

  return json({ success: true, message: "Account deletion cancelled. Your account is fully restored." });
});
