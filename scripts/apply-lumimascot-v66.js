#!/usr/bin/env node
/**
 * scripts/apply-lumimascot-v66.js   (v2 — regex-based, drift-tolerant)
 *
 * USAGE (from repo root, Windows CMD):
 *   node scripts\apply-lumimascot-v66.js
 *
 * WHAT CHANGED FROM v1
 *   • bubbleText block is matched by REGEX, not exact string. The script
 *     finds any ternary that starts with `const bubbleText = message !== undefined`
 *     and ends with `: '';` — no matter what the middle looks like.
 *   • On miss, prints a 30-line snippet around `const bubbleText` so we can
 *     see exactly what your file looks like and adjust if needed.
 *
 * SAFETY
 *   • Writes `.bak` before any edit
 *   • Idempotent — re-running detects the v6.6 marker and exits clean
 *   • Refuses to write if either anchor is missing
 */

const fs   = require('fs');
const path = require('path');

const FILE = path.join('components', 'Lumi', 'LumiMascot.tsx');

// ─── Edit 1: the import line ──────────────────────────────────────────────────

const OLD_IMPORT =
  `import { playLumiForState } from './lumiSounds';`;

const NEW_IMPORT =
  `import { playLumiForState, subscribeLumiText } from './lumiSounds';`;

// ─── Edit 2: the bubbleText ternary — matched by regex ────────────────────────
// Matches:
//   <leading whitespace>const bubbleText = message !== undefined
//     ... anything across multiple lines (non-greedy) ...
//   : '';
//
// Captures leading whitespace so the replacement keeps the same indentation.

const BUBBLE_REGEX = /^([ \t]*)const bubbleText = message !== undefined[\s\S]*?:\s*'';/m;

function buildReplacement(indent) {
  return [
    `${indent}// ─── v6.6: "what is Lumi saying right now?" ─────────────────────`,
    `${indent}// lumiSounds.ts emits the spoken text from the voice manifest`,
    `${indent}// whenever a voice clip starts playing. We mirror that into local`,
    `${indent}// state so the bubble can render the exact phrase the audio is`,
    `${indent}// speaking.`,
    `${indent}//`,
    `${indent}// For states with NO voice (idle / out-of-juice / guide / fail with`,
    `${indent}// sound off), voiceText stays null and we fall back to the lumiQuotes`,
    `${indent}// pool below.`,
    `${indent}const [voiceText, setVoiceText] = useState<string | null>(null);`,
    `${indent}useEffect(() => {`,
    `${indent}  const unsub = subscribeLumiText(setVoiceText);`,
    `${indent}  return unsub;`,
    `${indent}}, []);`,
    `${indent}// Auto-expire so the bubble doesn't linger forever if a clip finishes`,
    `${indent}// without the next state-change emitting a new text or null.`,
    `${indent}useEffect(() => {`,
    `${indent}  if (!voiceText) return;`,
    `${indent}  const id = setTimeout(() => setVoiceText(null), 3500);`,
    `${indent}  return () => clearTimeout(id);`,
    `${indent}}, [voiceText]);`,
    ``,
    `${indent}// Priority order:`,
    `${indent}//   1. Explicit \`message\` prop (parent override) — always wins`,
    `${indent}//   2. Active voice text (audio is currently speaking it)`,
    `${indent}//   3. Quote-pool fallback (no audio, e.g. sound disabled or idle)`,
    `${indent}const bubbleText = message !== undefined`,
    `${indent}  ? message`,
    `${indent}  : voiceText`,
    `${indent}    ? voiceText`,
    `${indent}    : LUMI_QUOTES[intent]?.length`,
    `${indent}      ? pickLumiQuote(intent, salt)`,
    `${indent}      : '';`,
  ].join('\n');
}

// ─── Idempotency marker — present after a successful run ──────────────────────
const IDEMPOTENCY_MARKER = `subscribeLumiText(setVoiceText)`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

function dumpContext(src, needle, lines = 30) {
  const idx = src.indexOf(needle);
  if (idx === -1) {
    console.error(`  (couldn't find "${needle}" anywhere in the file)`);
    return;
  }
  const allLines = src.split('\n');
  let acc = 0, lineNum = 0;
  for (let i = 0; i < allLines.length; i++) {
    acc += allLines[i].length + 1;
    if (acc > idx) { lineNum = i; break; }
  }
  const start = Math.max(0, lineNum - 4);
  const end   = Math.min(allLines.length, lineNum + lines);
  console.error('  ── snippet from your file (paste this back if you need help) ──');
  for (let i = start; i < end; i++) {
    const marker = i === lineNum ? '>' : ' ';
    console.error(`  ${marker} ${String(i + 1).padStart(4)} | ${allLines[i]}`);
  }
  console.error('  ──────────────────────────────────────────────────────────────');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

if (!fs.existsSync(FILE)) {
  bail(`Could not find ${FILE}. Run from your repo root (where package.json lives).`);
}

let src;
try {
  src = fs.readFileSync(FILE, 'utf8');
} catch (e) {
  bail(`Could not read ${FILE}: ${e.message}`);
}

if (src.includes(IDEMPOTENCY_MARKER)) {
  ok(`${FILE} already contains the v6.6 edits — nothing to do.`);
  process.exit(0);
}

const hasImport   = src.includes(OLD_IMPORT);
const bubbleMatch = src.match(BUBBLE_REGEX);

if (!hasImport || !bubbleMatch) {
  console.error('');
  console.error('X Could not find one or both expected snippets in LumiMascot.tsx.');
  console.error(`    OLD_IMPORT       ${hasImport   ? 'FOUND' : 'NOT FOUND'}`);
  console.error(`    bubbleText block ${bubbleMatch ? 'FOUND' : 'NOT FOUND'}`);
  console.error('');
  if (!bubbleMatch) {
    console.error('  Looking for: a ternary starting with');
    console.error('    `const bubbleText = message !== undefined`');
    console.error("  and ending with `: '';`");
    console.error('');
    dumpContext(src, 'const bubbleText', 30);
    console.error('');
    console.error("  Paste the snippet above back to me and I'll adjust the regex.");
  }
  process.exit(1);
}

const indent = bubbleMatch[1] || '  ';

const bakPath = FILE + '.bak';
try {
  fs.writeFileSync(bakPath, src, 'utf8');
  ok(`backup written -> ${bakPath}`);
} catch (e) {
  bail(`Could not write backup ${bakPath}: ${e.message}`);
}

let next = src;
next = next.replace(OLD_IMPORT, NEW_IMPORT);
next = next.replace(BUBBLE_REGEX, buildReplacement(indent));

if (!next.includes(IDEMPOTENCY_MARKER)) {
  bail('Replacement ran but the v6.6 marker is missing. Aborting before write.');
}

try {
  fs.writeFileSync(FILE, next, 'utf8');
  ok(`${FILE} updated.`);
} catch (e) {
  bail(`Could not write ${FILE}: ${e.message}`);
}

console.log('');
ok('LumiMascot.tsx v6.6 edits applied. Next:');
console.log('    1. npx tsc --noEmit                          (verify TS clean)');
console.log('    2. del components\\Lumi\\LumiMascot.tsx.bak   (after you are happy)');
console.log('');
