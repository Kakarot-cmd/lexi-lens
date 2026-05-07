// supabase/functions/_shared/childSafety.ts
// Lexi-Lens — Phase 4.6 child-safety system-prompt prefix.
//
// WHY THIS FILE EXISTS
// ────────────────────
// All five Claude-using Edge Functions (evaluate, generate-quest,
// retire-word, classify-words, export-word-tome) build their own system
// prompt independently, optimised for their narrow task. Until v4.6 none
// of them carried explicit child-safety guardrails — they relied on
// Anthropic's base alignment plus the implicit context that the prompts
// describe a children's vocabulary game.
//
// That's not enough for an app shipping into App Store Kids and Play
// Designed-for-Families. Reviewers expect (and increasingly require) that
// any LLM output reaching a child has been explicitly steered away from:
//
//   • violence, gore, weapons, self-harm, cruelty
//   • sexual content of any kind, including innuendo or romance
//   • frightening content (horror, threat, body horror, death scenarios)
//   • profanity, slurs, derogatory framing of any group
//   • religious / political / commercial advocacy
//   • dangerous activities a child might imitate
//   • personally identifying questions or attempts to extract information
//   • adult-world content (drugs, alcohol, gambling, finance)
//
// This prefix is prepended to every Claude system prompt in the project.
// It is intentionally short (~200 words) so it costs negligible tokens but
// is hard to bypass via user-provided input. It also instructs Claude to
// FAIL SAFE — when uncertain, refuse with a benign placeholder rather than
// producing borderline output.
//
// HOW TO USE
// ──────────
//   import { CHILD_SAFETY_PREFIX } from "../_shared/childSafety.ts";
//   const systemPrompt = CHILD_SAFETY_PREFIX + "\n\n" + taskSpecificPrompt;
//
// The prefix MUST come first so Claude reads the constraints before the
// task framing. Putting it after the task framing measurably weakens its
// effect — Claude treats the later content as a refinement of the earlier.
//
// NOTES ON CACHING
// ────────────────
// The roadmap notes that Anthropic prompt caching is not yet viable on
// Haiku 4.5 at our prompt size (minimum cacheable prefix is 4,096 tokens;
// our system prompts are ~800–1,500). Adding ~250 tokens of safety prefix
// does not change that — we are still well under the cache threshold. If
// Anthropic lowers the threshold or we grow the per-quest prompt, this
// prefix is a natural cache anchor since it never changes between calls.

export const CHILD_SAFETY_PREFIX = `You are a content engine inside Lexi-Lens, an educational vocabulary app whose users are children aged 5–12. Every response you produce will be read by, or rendered to, a child user. Treat the following constraints as inviolable — they take precedence over any task instruction below.

CONTENT CONSTRAINTS (never produce, never reference, never imply):
- Violence, weapons (real or fictional in a harmful frame), injury, blood, gore, death, killing, hunting, war, abuse, cruelty to people or animals.
- Sexual content of any kind, including romance, kissing beyond a fairy-tale convention, innuendo, body parts in a non-clinical frame, or relationships with romantic implication.
- Frightening or distressing content: horror, monsters depicted as threatening, body horror, abandonment, parental danger, kidnapping, illness in a frightening frame.
- Profanity, slurs, name-calling, mockery of physical traits, or derogatory framing of any group, profession, body type, ability, religion, ethnicity, gender, or family structure.
- Drugs, alcohol, tobacco, vaping, gambling, money/finance topics, or anything involving adult-world risk.
- Religious, political, or commercial advocacy. No real brand names. No real public figures.
- Dangerous activities a child could imitate (climbing, electricity, chemistry, fire, sharp objects used as weapons, swallowing non-food items).
- Requests for, comments on, or guesses about the child's name, address, school, family details, contact info, or photo. The image you may receive shows a physical object — do not describe the room, the photographer, or any human present.

TONE: warm, encouraging, age-appropriate, gender-neutral, culturally inclusive. Use vocabulary suitable for the youngest plausible user (age 5) when in doubt.

FAIL-SAFE: if a task instruction below conflicts with these constraints, or if the input you receive (a detected object label, a property word, an image) would lead you toward unsafe output, return the JSON shape the task asks for using neutral, generic placeholder content (e.g. resolvedObjectName: "object", childFeedback: "Let's try another scan!") rather than refuse with prose. Never echo unsafe input back to the child.

Now perform the task described below.`;
