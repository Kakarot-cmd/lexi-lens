/**
 * supabase/functions/record-consent/index.ts
 * Lexi-Lens — Phase 4.1 COPPA + GDPR-K Compliance
 *
 * POST /functions/v1/record-consent
 *
 * WHY THIS EXISTS:
 *   The client-side insert into parental_consents requires an active session
 *   (auth.uid() must match parent_id for the RLS policy to pass). When Supabase
 *   has email confirmation enabled, signUp() returns data.session = null — so
 *   the client has no JWT and the RLS insert fails silently.
 *
 *   This Edge Function uses the SERVICE ROLE key, bypasses RLS entirely, and
 *   can be called immediately after signUp() regardless of session state.
 *
 * REQUEST BODY:
 *   {
 *     userId:                 string,   // auth.users.id of the newly created parent
 *     policyVersion:          string,   // e.g. "1.0"
 *     consentedAt:            string,   // ISO 8601 timestamp
 *     coppaConfirmed:         boolean,
 *     gdprKConfirmed:         boolean,
 *     aiProcessingConfirmed:  boolean,
 *     parentalGatePassed:     boolean,
 *   }
 *
 * SECURITY:
 *   • userId comes from the signUp() response on the client — it is the actual
 *     new user's ID. We do NOT verify the caller's JWT here because immediately
 *     after signUp the user may have no session (email confirmation pending).
 *   • The function is deployed with --no-verify-jwt.
 *   • We validate all required fields server-side before inserting.
 *   • ON CONFLICT DO NOTHING prevents duplicate rows if the client retries.
 *
 * DEPLOY:
 *   supabase functions deploy record-consent --no-verify-jwt
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  // Handle CORS pre-flight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // ── Parse & validate body ────────────────────────────────────────────────
    const body = await req.json();

    const {
      userId,
      policyVersion,
      consentedAt,
      coppaConfirmed,
      gdprKConfirmed,
      aiProcessingConfirmed,
      parentalGatePassed,
    } = body;

    // All fields are required — reject incomplete consent records
    if (!userId || typeof userId !== "string") {
      return new Response(JSON.stringify({ error: "userId is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!policyVersion || !consentedAt) {
      return new Response(JSON.stringify({ error: "policyVersion and consentedAt are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (coppaConfirmed !== true || gdprKConfirmed !== true ||
        aiProcessingConfirmed !== true || parentalGatePassed !== true) {
      return new Response(JSON.stringify({ error: "All consent checkboxes must be true" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Service role client (bypasses RLS) ───────────────────────────────────
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } }
    );

    // ── Insert consent record ────────────────────────────────────────────────
    const { error } = await supabaseAdmin
      .from("parental_consents")
      .insert({
        parent_id:               userId,
        policy_version:          policyVersion,
        consented_at:            consentedAt,
        coppa_confirmed:         coppaConfirmed,
        gdpr_k_confirmed:        gdprKConfirmed,
        ai_processing_confirmed: aiProcessingConfirmed,
        parental_gate_passed:    parentalGatePassed,
      })
      .select()
      .single();

    // ON CONFLICT is not available as a JS method for single inserts,
    // so we treat duplicate key errors as success (idempotent).
    if (error && !error.message.includes("duplicate key")) {
      console.error("[record-consent] insert failed:", error.message);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ success: true, userId, policyVersion }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );

  } catch (err: any) {
    console.error("[record-consent] unexpected error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
