/**
 * supabase/functions/evaluate/index.ts
 * Lexi-Lens — Supabase Edge Function (Deno runtime)
 *
 * This is the secure gateway between the React Native client and Claude.
 * The ANTHROPIC_API_KEY never touches the device — it lives here only.
 *
 * Deploy:
 *   supabase functions deploy evaluate --no-verify-jwt
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
 *
 * Local dev:
 *   supabase functions serve evaluate --env-file .env.local
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Types (mirrors evaluateObject.ts) ───────────────────────────────────────

interface PropertyRequirement {
  word: string;
  definition: string;
  evaluationHints?: string;
}

interface PropertyScore {
  word: string;
  score: number;
  reasoning: string;
  passes: boolean;
}

interface EvaluationResult {
  resolvedObjectName: string;
  properties: PropertyScore[];
  overallMatch: boolean;
  childFeedback: string;
  nudgeHint?: string | null;
  xpAwarded: number;
}

interface EvaluateRequest {
  childId: string;
  questId: string;
  detectedLabel: string;
  confidence: number;
  /** Base64 JPEG — optional, improves accuracy */
  frameBase64?: string | null;
  requiredProperties: PropertyRequirement[];
  childAge: number;
  failedAttempts?: number;
  questName?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PROPERTY_PASS_THRESHOLD = 0.7;
const XP_FIRST_TRY = 40;
const XP_RETRY = 20;
const XP_LATE = 10;
const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 600;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(childAge: number, questName?: string): string {
  return `You are a warm, encouraging vocabulary tutor in a fantasy RPG game called Lexi-Lens.
Children aged 5–12 point their camera at real objects at home to find "material components" for spells.
${questName ? `Current quest: "${questName}".` : ""}
The child is approximately ${childAge} years old. Match language complexity to this age.

CRITICAL SAFETY RULES:
- Only discuss the object's physical properties. Never comment on the child, their home,
  or anything else visible in the frame.
- All feedback must be warm, encouraging, and age-appropriate.
- Never name the correct answer object — guide without spoiling.
- If the camera frame shows anything inappropriate, respond ONLY with:
  {"error":"unable_to_evaluate"}

RESPONSE FORMAT: Valid JSON only. No markdown. No explanation outside JSON.
{
  "resolvedObjectName": string,
  "properties": [{ "word": string, "score": number, "reasoning": string, "passes": boolean }],
  "overallMatch": boolean,
  "childFeedback": string,
  "nudgeHint": string | null
}`;
}

// ─── Claude call ──────────────────────────────────────────────────────────────

async function callClaude(req: EvaluateRequest): Promise<Omit<EvaluationResult, "xpAwarded">> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const propertyList = req.requiredProperties
    .map((p, i) =>
      `${i + 1}. "${p.word}" — ${p.definition}${p.evaluationHints ? ` | Hint: ${p.evaluationHints}` : ""}`
    )
    .join("\n");

  const textContent = {
    type: "text",
    text: `Detected object: "${req.detectedLabel}" (confidence: ${(req.confidence * 100).toFixed(0)}%).

Required properties (ALL must pass):
${propertyList}

Failed attempts so far: ${req.failedAttempts ?? 0}
${(req.failedAttempts ?? 0) >= 2 ? "Include a gentle nudgeHint." : "Set nudgeHint to null."}`,
  };

  const content = req.frameBase64
    ? [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: req.frameBase64 } },
        textContent,
      ]
    : [textContent];

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(req.childAge, req.questName),
      messages: [{ role: "user", content }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const rawText: string = data.content
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");

  const clean = rawText.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);

  if (parsed.error === "unable_to_evaluate") {
    throw new Error("Frame could not be evaluated safely.");
  }

  // Enforce pass threshold server-side (don't trust Claude's boolean)
  parsed.properties = parsed.properties.map((p: PropertyScore) => ({
    ...p,
    passes: p.score >= PROPERTY_PASS_THRESHOLD,
  }));
  parsed.overallMatch = parsed.properties.every((p: PropertyScore) => p.passes);

  return parsed;
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

function makeSupabase(authHeader: string | null) {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    authHeader ? { global: { headers: { Authorization: authHeader } } } : {}
  );
}

async function verifyChildOwnership(
  supabase: ReturnType<typeof makeSupabase>,
  childId: string,
  userId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("child_profiles")
    .select("id")
    .eq("id", childId)
    .eq("parent_id", userId)
    .single();
  return !!data;
}

async function persistResult(
  supabase: ReturnType<typeof makeSupabase>,
  req: EvaluateRequest,
  result: Omit<EvaluationResult, "xpAwarded">,
  xpAwarded: number,
  latencyMs: number
) {
  // Record the scan attempt (no camera frame stored)
  await supabase.from("scan_attempts").insert({
    child_id: req.childId,
    quest_id: req.questId,
    detected_label: req.detectedLabel,
    vision_confidence: req.confidence,
    resolved_name: result.resolvedObjectName,
    overall_match: result.overallMatch,
    property_scores: result.properties,
    child_feedback: result.childFeedback,
    xp_awarded: xpAwarded,
    claude_latency_ms: latencyMs,
  });

  if (!result.overallMatch) return;

  // Award XP and update level
  await supabase.rpc("award_xp", { p_child_id: req.childId, p_xp: xpAwarded });

  // Update Word Tome for each passing property
  for (const prop of result.properties.filter((p) => p.passes)) {
    const requirement = req.requiredProperties.find((r) => r.word === prop.word);
    if (!requirement) continue;
    await supabase.rpc("record_word_learned", {
      p_child_id: req.childId,
      p_word: prop.word,
      p_definition: requirement.definition,
      p_exemplar_object: result.resolvedObjectName,
    });
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    // ── Auth ──────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const supabase = makeSupabase(authHeader);
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // ── Parse & validate request body ─────────────────────────
    const body: EvaluateRequest = await req.json();
    const { childId, questId, detectedLabel, confidence, requiredProperties, childAge } = body;

    if (!childId || !questId || !detectedLabel || !requiredProperties?.length || !childAge) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Ensure this parent actually owns this child profile
    const isOwner = await verifyChildOwnership(supabase, childId, user.id);
    if (!isOwner) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // ── Call Claude ───────────────────────────────────────────
    const claudeStart = Date.now();
    const result = await callClaude(body);
    const claudeLatency = Date.now() - claudeStart;

    // ── Compute XP server-side ────────────────────────────────
    const attempts = body.failedAttempts ?? 0;
    const xpAwarded = result.overallMatch
      ? attempts === 0 ? XP_FIRST_TRY : attempts === 1 ? XP_RETRY : XP_LATE
      : 0;

    // ── Persist (fire-and-forget, don't block response) ───────
    persistResult(supabase, body, result, xpAwarded, claudeLatency).catch(console.error);

    // ── Respond ───────────────────────────────────────────────
    const finalResult: EvaluationResult = { ...result, xpAwarded };

    return new Response(JSON.stringify(finalResult), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("evaluate function error:", err);

    const isKnownError = err instanceof Error && err.message.includes("safely");
    return new Response(
      JSON.stringify({ error: isKnownError ? err.message : "Internal server error" }),
      {
        status: isKnownError ? 422 : 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }
});
