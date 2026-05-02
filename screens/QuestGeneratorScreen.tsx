/**
 * QuestGeneratorScreen.tsx — Lexi-Lens Phase 3.3
 * AI Quest Generator for parents.
 *
 * Rendered as a full-screen Modal from ParentDashboard — no navigator needed.
 *
 * Flow:
 *   Step 1 — INPUT:   Parent types a theme, picks age band + tier + propCount → Generate
 *   Step 2 — PREVIEW: Editable quest card — name, enemy, room, N properties (add/delete) → Save
 *   Step 3 — SAVED:   Success screen with a link to see it in the Dungeon Map
 *
 * Property count changes (this PR):
 *   • Step 1 now has a 1–5 chip picker ("How many vocabulary words?") — default 3.
 *   • propCount is passed to the Edge Function so Claude generates exactly N words.
 *   • Step 2 adds a delete button per property (visible when count > 1).
 *   • Step 2 adds an "+ Add property" dashed button (visible when count < 5).
 *   • A "N / 5" badge sits top-right of the properties section.
 *
 * Validation changes (Phase word-audit):
 *   • buildKnownWordsSet() replaces inline Supabase tome query — fixes forAllChildren gap.
 *   • validateQuestWords() runs client-side after Edge Function returns — catches both
 *     required_properties AND hard_mode_properties that Claude may have repeated.
 *   • StepPreview shows an amber warning banner + flagged property cards when any
 *     known word slips through. Non-blocking — parent can still save or regenerate.
 *
 * The saved quest appears in the child's QuestMap immediately
 * (visibility: 'private', created_by: parent uid).
 */

import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Modal,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Dimensions,
} from "react-native";
import * as Haptics from "expo-haptics";
import { supabase } from "../lib/supabase";
import {
  buildKnownWordsSet,
  validateQuestWords,
  flaggedRequiredIndexSet,
  type ValidationResult,
} from "../utils/questValidation";

const { width: W } = Dimensions.get("window");

// ─── Palette — parent warm tones ─────────────────────────────────────────────

const P = {
  cream:        "#fdf8f0",
  parchment:    "#f5edda",
  warmBorder:   "#e2d0b0",
  inkBrown:     "#3d2a0f",
  inkMid:       "#6b4c1e",
  inkLight:     "#9c7540",
  inkFaint:     "#c4a97a",
  amber:        "#d97706",
  amberLight:   "#fef3c7",
  amberBorder:  "#fde68a",
  purple:       "#7c3aed",
  purpleLight:  "#f5f3ff",
  purpleBorder: "#ddd6fe",
  green:        "#166534",
  greenLight:   "#f0fdf4",
  greenBorder:  "#86efac",
  errorBg:      "#fff1f2",
  errorBorder:  "#fecdd3",
  errorText:    "#9f1239",
  white:        "#ffffff",
};

// ─── Constants ────────────────────────────────────────────────────────────────

const AGE_BANDS = [
  { band: "5-6",   label: "5–6 yrs",   desc: "Early reader" },
  { band: "7-8",   label: "7–8 yrs",   desc: "Developing"   },
  { band: "9-10",  label: "9–10 yrs",  desc: "Advancing"    },
  { band: "11-12", label: "11–12 yrs", desc: "Proficient"   },
] as const;
type AgeBand = typeof AGE_BANDS[number]["band"];

const TIERS = [
  { key: "apprentice", emoji: "🌱", label: "Apprentice", desc: "Easy words" },
  { key: "scholar",    emoji: "📖", label: "Scholar",    desc: "Medium"     },
  { key: "sage",       emoji: "🔮", label: "Sage",       desc: "Advanced"   },
  { key: "archmage",   emoji: "⚡", label: "Archmage",   desc: "Expert"     },
] as const;
type Tier = typeof TIERS[number]["key"];

const TIER_COLOR: Record<Tier, string> = {
  apprentice: "#86efac",
  scholar:    "#93c5fd",
  sage:       "#c4b5fd",
  archmage:   "#fbbf24",
};

// Property count picker
const PROP_COUNT_OPTIONS = [1, 2, 3, 4, 5] as const;
type PropCount = typeof PROP_COUNT_OPTIONS[number];

const PROP_COUNT_META: Record<PropCount, { label: string; desc: string }> = {
  1: { label: "1",  desc: "Quick"    },
  2: { label: "2",  desc: "Short"    },
  3: { label: "3",  desc: "Standard" },
  4: { label: "4",  desc: "Deep"     },
  5: { label: "5",  desc: "Epic"     },
};

const MIN_PROPS = 1;
const MAX_PROPS = 5;

// ─── Types ────────────────────────────────────────────────────────────────────

interface PropertyRequirement {
  word:            string;
  definition:      string;
  evaluationHints: string;
}

interface GeneratedQuest {
  name:                 string;
  enemy_name:           string;
  enemy_emoji:          string;
  room_label:           string;
  spell_name:           string;
  weapon_emoji:         string;
  spell_description:    string;
  required_properties:  PropertyRequirement[];
  hard_mode_properties?: PropertyRequirement[];
}

interface TargetChild {
  id:           string;
  display_name: string;
  age_band:     string;
}

interface Props {
  visible:         boolean;
  onClose:         () => void;
  defaultAgeBand?: AgeBand;
  targetChild?:    TargetChild | null;
}

// ─── Step 1: Theme input ──────────────────────────────────────────────────────

function StepInput({
  onGenerate,
  defaultAgeBand,
  targetChild,
  forAllChildren,
  setForAllChildren,
  propCount,
  setPropCount,
}: {
  onGenerate:        (theme: string, ageBand: AgeBand, tier: Tier, propCount: number) => void;
  defaultAgeBand:    AgeBand;
  targetChild:       TargetChild | null;
  forAllChildren:    boolean;
  setForAllChildren: (v: boolean) => void;
  propCount:         number;
  setPropCount:      (n: number) => void;
}) {
  const [theme,   setTheme]   = useState("");
  const [ageBand, setAgeBand] = useState<AgeBand>(defaultAgeBand);
  const [tier,    setTier]    = useState<Tier>("apprentice");

  const canGenerate = theme.trim().length >= 3;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1 }}
    >
      <ScrollView
        contentContainerStyle={styles.stepPad}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Intro */}
        <Text style={styles.stepTitle}>✨ Create a Quest</Text>
        <Text style={styles.stepSub}>
          Describe a theme and Claude will design a complete vocabulary quest for your child.
        </Text>

        {/* Theme input */}
        <Text style={styles.fieldLabel}>Quest theme</Text>
        <TextInput
          style={styles.themeInput}
          placeholder='e.g. "ocean creatures", "kitchen magic", "space adventure"'
          placeholderTextColor={P.inkFaint}
          value={theme}
          onChangeText={setTheme}
          maxLength={200}
          multiline
          returnKeyType="done"
          autoFocus
          accessibilityLabel="Quest theme"
        />
        <Text style={styles.charCount}>{theme.length}/200</Text>

        {/* ── Property count picker ─────────────────────────────────────────── */}
        <Text style={[styles.fieldLabel, { marginTop: 22 }]}>
          How many vocabulary words?
        </Text>
        <Text style={styles.propCountSub}>
          More words = longer quest. 3 is ideal for most children.
        </Text>
        <View style={styles.propCountRow}>
          {PROP_COUNT_OPTIONS.map((n) => {
            const active = propCount === n;
            const meta   = PROP_COUNT_META[n];
            return (
              <TouchableOpacity
                key={n}
                style={[styles.propCountChip, active && styles.propCountChipActive]}
                onPress={() => { setPropCount(n); Haptics.selectionAsync(); }}
                accessibilityLabel={`${n} properties, ${meta.desc}`}
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.propCountNum, active && styles.propCountNumActive]}>
                  {meta.label}
                </Text>
                <Text style={[styles.propCountDesc, active && styles.propCountDescActive]}>
                  {meta.desc}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Age band */}
        <Text style={[styles.fieldLabel, { marginTop: 22 }]}>Child's age range</Text>
        <View style={styles.chipRow}>
          {AGE_BANDS.map((b) => {
            const sel = ageBand === b.band;
            return (
              <TouchableOpacity
                key={b.band}
                style={[styles.chip, sel && { borderColor: P.amber, backgroundColor: P.amberLight }]}
                onPress={() => { setAgeBand(b.band); Haptics.selectionAsync(); }}
              >
                <Text style={[styles.chipLabel, sel && { color: P.amber }]}>{b.label}</Text>
                <Text style={[styles.chipDesc,  sel && { color: P.inkLight }]}>{b.desc}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Tier */}
        <Text style={[styles.fieldLabel, { marginTop: 22 }]}>Difficulty tier</Text>
        <View style={styles.tierRow}>
          {TIERS.map((t) => {
            const sel   = tier === t.key;
            const color = TIER_COLOR[t.key];
            return (
              <TouchableOpacity
                key={t.key}
                style={[
                  styles.tierChip,
                  sel && { borderColor: color, backgroundColor: color + "20" },
                ]}
                onPress={() => { setTier(t.key); Haptics.selectionAsync(); }}
              >
                <Text style={styles.tierEmoji}>{t.emoji}</Text>
                <Text style={[styles.tierChipLabel, sel && { color }]}>{t.label}</Text>
                <Text style={styles.tierChipDesc}>{t.desc}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Generate button */}
        <TouchableOpacity
          style={[styles.generateBtn, !canGenerate && styles.generateBtnDisabled]}
          disabled={!canGenerate}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onGenerate(theme.trim(), ageBand, tier, propCount);
          }}
        >
          <Text style={styles.generateBtnText}>
            ✦ Generate Quest · {propCount} {propCount === 1 ? "word" : "words"}
          </Text>
        </TouchableOpacity>

        {/* Child targeting */}
        {targetChild && (
          <View style={styles.targetRow}>
            <Text style={styles.targetLabel}>Create for:</Text>
            <TouchableOpacity
              style={[styles.targetChip, !forAllChildren && styles.targetChipActive]}
              onPress={() => setForAllChildren(false)}
            >
              <Text style={[styles.targetChipText, !forAllChildren && styles.targetChipTextActive]}>
                👦 {targetChild.display_name} only
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.targetChip, forAllChildren && styles.targetChipActive]}
              onPress={() => setForAllChildren(true)}
            >
              <Text style={[styles.targetChipText, forAllChildren && styles.targetChipTextActive]}>
                👨‍👩‍👧‍👦 All children
              </Text>
            </TouchableOpacity>
          </View>
        )}

        <Text style={styles.aiNote}>
          Powered by Claude AI · Generates in ~5 seconds · You can edit before saving
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Editable property row ────────────────────────────────────────────────────

function PropertyEditor({
  prop,
  index,
  onChange,
  onDelete,
  canDelete,
  isFlagged = false,
}: {
  prop:       PropertyRequirement;
  index:      number;
  onChange:   (updated: PropertyRequirement) => void;
  onDelete:   () => void;
  canDelete:  boolean;
  isFlagged?: boolean;
}) {
  return (
    <View style={[styles.propEditor, isFlagged && styles.propEditorFlagged]}>
      {/* Header: label + flagged badge + delete */}
      <View style={styles.propHeader}>
        <Text style={styles.propIndex}>Property {index + 1}</Text>

        {/* Amber "Already in Tome" badge — only shown when flagged */}
        {isFlagged && (
          <View style={styles.flaggedBadge}>
            <Text style={styles.flaggedBadgeText}>⚠ Already in Tome</Text>
          </View>
        )}

        {canDelete && (
          <TouchableOpacity
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onDelete();
            }}
            style={styles.propDeleteBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={`Remove property ${index + 1}`}
          >
            <Text style={styles.propDeleteText}>✕ Remove</Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={styles.propFieldLabel}>Word</Text>
      <TextInput
        style={styles.propInput}
        value={prop.word}
        onChangeText={(v) => onChange({ ...prop, word: v })}
        placeholder="vocabulary word"
        placeholderTextColor={P.inkFaint}
        autoCapitalize="none"
      />
      <Text style={styles.propFieldLabel}>Definition</Text>
      <TextInput
        style={[styles.propInput, { minHeight: 52 }]}
        value={prop.definition}
        onChangeText={(v) => onChange({ ...prop, definition: v })}
        placeholder="child-friendly definition"
        placeholderTextColor={P.inkFaint}
        multiline
      />
      <Text style={styles.propFieldLabel}>Evaluation hint (for AI)</Text>
      <TextInput
        style={[styles.propInput, { minHeight: 52 }]}
        value={prop.evaluationHints}
        onChangeText={(v) => onChange({ ...prop, evaluationHints: v })}
        placeholder="what should the AI look for?"
        placeholderTextColor={P.inkFaint}
        multiline
      />
    </View>
  );
}

// ─── Step 2: Preview + edit ───────────────────────────────────────────────────

function StepPreview({
  quest: initial,
  ageBand,
  tier,
  onSave,
  onRegenerate,
  saving,
  validationResult,
}: {
  quest:             GeneratedQuest;
  ageBand:           AgeBand;
  tier:              Tier;
  onSave:            (q: GeneratedQuest) => void;
  onRegenerate:      () => void;
  saving:            boolean;
  validationResult?: ValidationResult | null;
}) {
  const [quest, setQuest] = useState<GeneratedQuest>(initial);
  const color = TIER_COLOR[tier];

  // Pre-compute which required_property indices are flagged — O(1) lookup in the list.
  const flaggedReqIdxs = validationResult
    ? flaggedRequiredIndexSet(validationResult)
    : new Set<number>();

  // ── Property handlers ─────────────────────────────────────────────────────
  const updateProp = (i: number, updated: PropertyRequirement) => {
    const props = [...quest.required_properties];
    props[i] = updated;
    setQuest({ ...quest, required_properties: props });
  };

  const addProp = () => {
    if (quest.required_properties.length >= MAX_PROPS) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setQuest({
      ...quest,
      required_properties: [
        ...quest.required_properties,
        { word: "", definition: "", evaluationHints: "" },
      ],
    });
  };

  const deleteProp = (i: number) => {
    if (quest.required_properties.length <= MIN_PROPS) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setQuest({
      ...quest,
      required_properties: quest.required_properties.filter((_, idx) => idx !== i),
    });
  };

  const propCount = quest.required_properties.length;
  const atMax     = propCount >= MAX_PROPS;
  const atMin     = propCount <= MIN_PROPS;

  return (
    <ScrollView
      contentContainerStyle={styles.stepPad}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.stepTitle}>📜 Preview Your Quest</Text>
      <Text style={styles.stepSub}>Edit any field before saving to your child's dungeon.</Text>

      {/* ── Validation warning banner ─────────────────────────────────────────
          Only shown when at least one word slipped through that the child
          already knows. Non-blocking — parent can regenerate or edit manually. */}
      {validationResult && !validationResult.isClean && (
        <View style={styles.validationBanner}>
          <Text style={styles.validationBannerIcon}>⚠</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.validationBannerTitle}>
              {validationResult.totalFlags} word
              {validationResult.totalFlags > 1 ? "s" : ""} already in child's Tome
            </Text>
            <Text style={styles.validationBannerBody}>
              {validationResult.summary}
            </Text>
          </View>
        </View>
      )}

      {/* Quest identity card */}
      <View style={[styles.previewCard, { borderColor: color }]}>
        {/* Enemy + name */}
        <View style={styles.previewHeader}>
          <TextInput
            style={styles.emojiInput}
            value={quest.enemy_emoji}
            onChangeText={(v) => setQuest({ ...quest, enemy_emoji: v })}
            maxLength={2}
          />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.previewFieldLabel}>Quest name</Text>
            <TextInput
              style={styles.previewNameInput}
              value={quest.name}
              onChangeText={(v) => setQuest({ ...quest, name: v })}
              placeholder="Quest name"
              placeholderTextColor={P.inkFaint}
            />
            <Text style={styles.previewFieldLabel}>Enemy name</Text>
            <TextInput
              style={styles.previewSubInput}
              value={quest.enemy_name}
              onChangeText={(v) => setQuest({ ...quest, enemy_name: v })}
              placeholder="Enemy name"
              placeholderTextColor={P.inkFaint}
            />
          </View>
        </View>

        {/* Room */}
        <Text style={styles.previewFieldLabel}>Room / location</Text>
        <TextInput
          style={styles.previewSubInput}
          value={quest.room_label}
          onChangeText={(v) => setQuest({ ...quest, room_label: v })}
          placeholder="Room label"
          placeholderTextColor={P.inkFaint}
        />

        {/* Spell */}
        <View style={styles.spellRow}>
          <TextInput
            style={styles.emojiInputSmall}
            value={quest.weapon_emoji}
            onChangeText={(v) => setQuest({ ...quest, weapon_emoji: v })}
            maxLength={2}
          />
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={styles.previewFieldLabel}>Spell name</Text>
            <TextInput
              style={styles.previewSubInput}
              value={quest.spell_name}
              onChangeText={(v) => setQuest({ ...quest, spell_name: v })}
              placeholder="Spell name"
              placeholderTextColor={P.inkFaint}
            />
          </View>
        </View>

        <Text style={styles.previewFieldLabel}>Spell description</Text>
        <TextInput
          style={[styles.previewSubInput, { minHeight: 48 }]}
          value={quest.spell_description}
          onChangeText={(v) => setQuest({ ...quest, spell_description: v })}
          placeholder="One sentence about the spell"
          placeholderTextColor={P.inkFaint}
          multiline
        />

        {/* Tier + age badges */}
        <View style={styles.badgeRow}>
          <View style={[styles.badge, { borderColor: color }]}>
            <Text style={[styles.badgeText, { color }]}>
              {TIERS.find((t) => t.key === tier)?.emoji}{" "}
              {tier.charAt(0).toUpperCase() + tier.slice(1)}
            </Text>
          </View>
          <View style={[styles.badge, { borderColor: P.amber }]}>
            <Text style={[styles.badgeText, { color: P.amber }]}>Age {ageBand}</Text>
          </View>
        </View>
      </View>

      {/* ── Properties section ───────────────────────────────────────────────── */}
      <View style={styles.propSectionHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.fieldLabel}>Vocabulary properties</Text>
          <Text style={styles.propHint}>
            Words your child learns by scanning objects. Min {MIN_PROPS} · Max {MAX_PROPS}.
          </Text>
        </View>
        {/* Count badge */}
        <View style={[styles.propCountBadge, atMax && styles.propCountBadgeFull]}>
          <Text style={[styles.propCountBadgeText, atMax && { color: "#d97706" }]}>
            {propCount} / {MAX_PROPS}
          </Text>
        </View>
      </View>

      {quest.required_properties.map((p, i) => (
        <PropertyEditor
          key={i}
          prop={p}
          index={i}
          onChange={(u) => updateProp(i, u)}
          onDelete={() => deleteProp(i)}
          canDelete={!atMin}
          isFlagged={flaggedReqIdxs.has(i)}
        />
      ))}

      {/* Add property — hidden at max */}
      {!atMax && (
        <TouchableOpacity
          style={styles.addPropBtn}
          onPress={addProp}
          accessibilityLabel="Add a vocabulary property"
        >
          <Text style={styles.addPropBtnText}>＋ Add property</Text>
        </TouchableOpacity>
      )}

      {/* Actions */}
      <TouchableOpacity
        style={[styles.saveBtn, saving && { opacity: 0.65 }]}
        disabled={saving}
        onPress={() => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          onSave(quest);
        }}
      >
        {saving
          ? <ActivityIndicator color={P.white} />
          : <Text style={styles.saveBtnText}>✦ Save to Dungeon Map</Text>}
      </TouchableOpacity>

      <TouchableOpacity style={styles.regenBtn} onPress={onRegenerate} disabled={saving}>
        <Text style={styles.regenBtnText}>↺ Regenerate with AI</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ─── Step 3: Success ──────────────────────────────────────────────────────────

function StepSuccess({
  quest,
  onClose,
  onCreateAnother,
  targetChild,
  forAllChildren,
}: {
  quest:           GeneratedQuest;
  onClose:         () => void;
  onCreateAnother: () => void;
  targetChild:     TargetChild | null;
  forAllChildren:  boolean;
}) {
  return (
    <View style={[styles.stepPad, styles.successWrap]}>
      <Text style={styles.successEmoji}>{quest.enemy_emoji}</Text>
      <Text style={styles.successTitle}>Quest Created!</Text>
      <Text style={styles.successSub}>
        <Text style={{ fontWeight: "700" }}>{quest.name}</Text>
        {" "}is now live in{" "}
        {targetChild && !forAllChildren
          ? `${targetChild.display_name}'s`
          : "your children's"}{" "}
        Dungeon Map.
      </Text>

      <View style={[styles.successCard, { borderColor: P.greenBorder }]}>
        <Text style={styles.successSpell}>{quest.weapon_emoji} {quest.spell_name}</Text>
        <Text style={styles.successRoom}>📍 {quest.room_label}</Text>
        <View style={styles.successWords}>
          {quest.required_properties.map((p, i) => (
            <View key={i} style={styles.wordPill}>
              <Text style={styles.wordPillText}>{p.word}</Text>
            </View>
          ))}
        </View>
      </View>

      <TouchableOpacity style={styles.doneBtn} onPress={onClose}>
        <Text style={styles.doneBtnText}>Done</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.anotherBtn} onPress={onCreateAnother}>
        <Text style={styles.anotherBtnText}>✦ Create another quest</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Generating overlay ───────────────────────────────────────────────────────

function GeneratingOverlay({ theme }: { theme: string }) {
  return (
    <View style={styles.generatingWrap}>
      <Text style={styles.generatingEmoji}>🔮</Text>
      <ActivityIndicator color={P.purple} size="large" style={{ marginTop: 16 }} />
      <Text style={styles.generatingTitle}>Claude is crafting your quest…</Text>
      <Text style={styles.generatingTheme}>"{theme}"</Text>
      <Text style={styles.generatingNote}>Designing enemy, room, and vocabulary properties</Text>
    </View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

type Step = "input" | "generating" | "preview" | "saved";

export default function QuestGeneratorScreen({
  visible,
  onClose,
  defaultAgeBand = "7-8",
  targetChild,
}: Props) {
  const [step,             setStep]             = useState<Step>("input");
  const [theme,            setTheme]            = useState("");
  const [ageBand,          setAgeBand]          = useState<AgeBand>(defaultAgeBand);
  const [tier,             setTier]             = useState<Tier>("apprentice");
  const [propCount,        setPropCount]        = useState(3);
  const [generated,        setGenerated]        = useState<GeneratedQuest | null>(null);
  const [savedQuest,       setSavedQuest]       = useState<GeneratedQuest | null>(null);
  const [saving,           setSaving]           = useState(false);
  const [error,            setError]            = useState<string | null>(null);
  const [forAllChildren,   setForAllChildren]   = useState(!targetChild);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);

  const reset = useCallback(() => {
    setStep("input");
    setTheme("");
    setAgeBand(defaultAgeBand);
    setTier("apprentice");
    setPropCount(3);
    setGenerated(null);
    setSavedQuest(null);
    setError(null);
    setSaving(false);
    setForAllChildren(!targetChild);
    setValidationResult(null);           // clear warnings when starting a fresh quest
  }, [targetChild, defaultAgeBand]);

  // ── Call Edge Function ────────────────────────────────────────────────────
  const handleGenerate = useCallback(async (
    inputTheme:     string,
    inputBand:      AgeBand,
    inputTier:      Tier,
    inputPropCount: number,
  ) => {
    setTheme(inputTheme);
    setAgeBand(inputBand);
    setTier(inputTier);
    setPropCount(inputPropCount);
    setStep("generating");
    setError(null);
    setValidationResult(null);           // clear any previous warnings while generating

    try {
      const childId = targetChild?.id ?? null;

      // ── Build known-words Set ──────────────────────────────────────────────
      // buildKnownWordsSet handles both single-child and forAllChildren modes.
      // Previously: only fetched if childId existed, leaving forAllChildren with
      // an empty knownWords list — the server guard was silently bypassed.
      // Now: when childId is null it unions ALL children's word_tomes so every
      // sibling's vocabulary is excluded from the generated quest.
      const knownWordsSet = await buildKnownWordsSet(childId, forAllChildren);
      const knownWords    = Array.from(knownWordsSet);

      // ── Mastery profile — separate query, still needs scores ──────────────
      // knownWordsSet is words-only; the mastery profile needs score + timesUsed
      // to calibrate Claude's difficulty. Only relevant for a specific child.
      let masteryProfile: Array<{
        word:        string;
        mastery:     number;
        masteryTier: string;
        timesUsed:   number;
      }> = [];

      if (childId) {
        const { data: tomeData } = await supabase
          .from("word_tome")
          .select("word, mastery_score, times_used")
          .eq("child_id", childId);

        if (tomeData && tomeData.length > 0) {
          masteryProfile = tomeData.map((r: any) => {
            const score: number = r.mastery_score ?? 0;
            const mt =
              score >= 0.8 ? "expert"
              : score >= 0.6 ? "proficient"
              : score >= 0.3 ? "developing"
              : "novice";
            return {
              word:        r.word,
              mastery:     Math.round(score * 100) / 100,
              masteryTier: mt,
              timesUsed:   r.times_used ?? 1,
            };
          });
        }
      }

      // ── Invoke Edge Function ───────────────────────────────────────────────
      const { data, error: fnError } = await supabase.functions.invoke("generate-quest", {
        body: {
          theme:         inputTheme,
          ageBand:       inputBand,
          tier:          inputTier,
          propCount:     inputPropCount,
          knownWords,
          masteryProfile,
        },
      });

      if (fnError) throw new Error(fnError.message ?? "Generation failed");
      if (!data?.quest) throw new Error("No quest returned from AI");

      // ── Client-side validation ─────────────────────────────────────────────
      // The Edge Function already guards required_properties server-side, but:
      //   1. hard_mode_properties are NOT checked server-side.
      //   2. Claude occasionally slips a known word through anyway (~5% rate).
      //   3. The server guard only fires a 422 — this surfaces inline warnings
      //      instead of a crash, giving parents context and a Regenerate option.
      const generatedQuest = data.quest;
      const result         = validateQuestWords(generatedQuest, knownWordsSet);
      setValidationResult(result);
      setGenerated(generatedQuest);
      setStep("preview");

    } catch (err: any) {
      setError(err.message ?? "Something went wrong");
      setStep("input");
      Alert.alert("Generation failed", err.message ?? "Please try again.");
    }
  }, [targetChild, forAllChildren]);   // forAllChildren added — affects knownWords fetch

  // ── Save to Supabase ──────────────────────────────────────────────────────
  const handleSave = useCallback(async (quest: GeneratedQuest) => {
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");

      const { error: insertErr } = await supabase.from("quests").insert({
        name:                 quest.name,
        enemy_name:           quest.enemy_name,
        enemy_emoji:          quest.enemy_emoji,
        room_label:           quest.room_label,
        min_age_band:         ageBand,
        tier:                 tier,
        sort_order:           8,
        xp_reward_first_try:  40,
        xp_reward_retry:      20,
        required_properties:  quest.required_properties,
        hard_mode_properties: quest.hard_mode_properties ?? [],
        age_band_properties:  {},
        spell_name:           quest.spell_name,
        weapon_emoji:         quest.weapon_emoji,
        spell_description:    quest.spell_description,
        created_by:           user.id,
        visibility:           "private",
        is_active:            true,
        target_child_id:      forAllChildren ? null : (targetChild?.id ?? null),
      });

      if (insertErr) throw insertErr;

      setSavedQuest(quest);
      setStep("saved");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      Alert.alert("Save failed", err.message ?? "Could not save quest. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [ageBand, tier, forAllChildren, targetChild]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>
            {step === "input"      ? "AI Quest Creator" : ""}
            {step === "generating" ? "Creating…"        : ""}
            {step === "preview"    ? "Edit & Save"      : ""}
            {step === "saved"      ? "Quest Ready! 🎉"  : ""}
          </Text>
          {step !== "generating" && (
            <TouchableOpacity
              onPress={
                step === "saved"    ? onClose
                : step === "preview" ? () => setStep("input")
                : onClose
              }
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={styles.headerBtn}
            >
              <Text style={styles.headerBtnText}>
                {step === "preview" ? "← Back" : "✕"}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Step indicator */}
        {step !== "saved" && (
          <View style={styles.stepper}>
            {(["input", "preview"] as const).map((s, i) => (
              <React.Fragment key={s}>
                <View style={[
                  styles.stepDot,
                  (step === s || (step === "generating" && s === "input"))
                    ? styles.stepDotActive : {},
                  step === "preview" && s === "input" ? styles.stepDotDone : {},
                ]}>
                  <Text style={styles.stepDotText}>{i + 1}</Text>
                </View>
                {i === 0 && (
                  <View style={[styles.stepLine, step === "preview" && styles.stepLineDone]} />
                )}
              </React.Fragment>
            ))}
          </View>
        )}

        {/* Content */}
        {step === "input" && (
          <StepInput
            onGenerate={handleGenerate}
            defaultAgeBand={defaultAgeBand}
            targetChild={targetChild ?? null}
            forAllChildren={forAllChildren}
            setForAllChildren={setForAllChildren}
            propCount={propCount}
            setPropCount={setPropCount}
          />
        )}
        {step === "generating" && <GeneratingOverlay theme={theme} />}
        {step === "preview" && generated && (
          <StepPreview
            quest={generated}
            ageBand={ageBand}
            tier={tier}
            onSave={handleSave}
            onRegenerate={() => handleGenerate(theme, ageBand, tier, propCount)}
            saving={saving}
            validationResult={validationResult}
          />
        )}
        {step === "saved" && savedQuest && (
          <StepSuccess
            quest={savedQuest}
            onClose={onClose}
            onCreateAnother={reset}
            targetChild={targetChild ?? null}
            forAllChildren={forAllChildren}
          />
        )}
      </View>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:            { flex: 1, backgroundColor: P.cream },

  // Header
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 20,
    paddingTop:        Platform.OS === "ios" ? 16 : 12,
    paddingBottom:     12,
    borderBottomWidth: 1,
    borderBottomColor: P.warmBorder,
  },
  headerTitle: { fontSize: 17, fontWeight: "700", color: P.inkBrown },
  headerBtn:   { paddingHorizontal: 4, paddingVertical: 4 },
  headerBtnText: { fontSize: 15, color: P.purple, fontWeight: "600" },

  // Stepper
  stepper: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "center",
    paddingVertical: 12,
    gap: 8,
  },
  stepDot: {
    width:           28,
    height:          28,
    borderRadius:    14,
    backgroundColor: P.parchment,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    alignItems:      "center",
    justifyContent:  "center",
  },
  stepDotActive: { backgroundColor: P.purple,   borderColor: P.purple   },
  stepDotDone:   { backgroundColor: P.amber,    borderColor: P.amber    },
  stepDotText:   { fontSize: 12, fontWeight: "700", color: P.white },
  stepLine:      { flex: 1, height: 1, backgroundColor: P.warmBorder,    maxWidth: 60 },
  stepLineDone:  { backgroundColor: P.amber },

  // Shared step layout
  stepPad: { paddingHorizontal: 20, paddingBottom: 40, paddingTop: 8 },
  stepTitle: {
    fontSize:     22,
    fontWeight:   "800",
    color:        P.inkBrown,
    marginBottom: 6,
    marginTop:    8,
  },
  stepSub: {
    fontSize:     14,
    color:        P.inkLight,
    lineHeight:   20,
    marginBottom: 20,
  },

  // Theme input
  fieldLabel: { fontSize: 13, fontWeight: "700", color: P.inkMid, marginBottom: 8 },
  themeInput: {
    backgroundColor:   P.white,
    borderRadius:      12,
    borderWidth:       1.5,
    borderColor:       P.warmBorder,
    paddingHorizontal: 14,
    paddingVertical:   12,
    fontSize:          15,
    color:             P.inkBrown,
    minHeight:         80,
    textAlignVertical: "top",
  },
  charCount: { fontSize: 11, color: P.inkFaint, textAlign: "right", marginTop: 4 },

  // Property count picker
  propCountSub: { fontSize: 12, color: P.inkLight, marginBottom: 10, lineHeight: 17 },
  propCountRow: { flexDirection: "row", gap: 8, marginBottom: 4 },
  propCountChip: {
    flex:              1,
    paddingVertical:   10,
    borderRadius:      10,
    borderWidth:       1.5,
    borderColor:       P.warmBorder,
    backgroundColor:   P.white,
    alignItems:        "center",
  },
  propCountChipActive: {
    borderColor:     P.purple,
    backgroundColor: P.purpleLight,
  },
  propCountNum: { fontSize: 16, fontWeight: "700", color: P.inkMid },
  propCountNumActive: { color: P.purple },
  propCountDesc: { fontSize: 10, color: P.inkFaint, marginTop: 2 },
  propCountDescActive: { color: P.purple },

  // Age band chips
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingVertical:   8,
    paddingHorizontal: 14,
    borderRadius:      10,
    borderWidth:       1.5,
    borderColor:       P.warmBorder,
    backgroundColor:   P.white,
    alignItems:        "center",
    minWidth:          (W - 56) / 4,
  },
  chipLabel: { fontSize: 13, fontWeight: "700", color: P.inkMid },
  chipDesc:  { fontSize: 10, color: P.inkFaint, marginTop: 1 },

  // Tier chips
  tierRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tierChip: {
    flex:              1,
    paddingVertical:   10,
    borderRadius:      10,
    borderWidth:       1.5,
    borderColor:       P.warmBorder,
    backgroundColor:   P.white,
    alignItems:        "center",
    minWidth:          (W - 72) / 4,
  },
  tierEmoji:      { fontSize: 20 },
  tierChipLabel:  { fontSize: 12, fontWeight: "700", color: P.inkMid, marginTop: 4 },
  tierChipDesc:   { fontSize: 10, color: P.inkFaint },

  // Generate button
  generateBtn: {
    backgroundColor: P.purple,
    borderRadius:    14,
    paddingVertical: 15,
    alignItems:      "center",
    marginTop:       28,
    marginBottom:    16,
  },
  generateBtnDisabled: { backgroundColor: P.inkFaint },
  generateBtnText: { color: P.white, fontSize: 16, fontWeight: "700" },

  // Child targeting row
  targetRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    flexWrap:      "wrap",
    marginBottom:  8,
  },
  targetLabel:       { fontSize: 13, color: P.inkLight, fontWeight: "600" },
  targetChip: {
    paddingVertical:   6,
    paddingHorizontal: 12,
    borderRadius:      20,
    borderWidth:       1,
    borderColor:       P.warmBorder,
    backgroundColor:   P.white,
  },
  targetChipActive: {
    borderColor:     P.purple,
    backgroundColor: P.purpleLight,
  },
  targetChipText:       { fontSize: 13, color: P.inkMid },
  targetChipTextActive: { color: P.purple, fontWeight: "600" },

  aiNote: {
    fontSize:  11,
    color:     P.inkFaint,
    textAlign: "center",
    marginTop: 12,
    lineHeight: 16,
  },

  // ── Validation warning banner ─────────────────────────────────────────────
  validationBanner: {
    flexDirection:   "row",
    alignItems:      "flex-start",
    gap:             10,
    backgroundColor: P.amberLight,
    borderWidth:     1,
    borderColor:     P.amberBorder,
    borderRadius:    10,
    padding:         12,
    marginBottom:    14,
  },
  validationBannerIcon: {
    fontSize:   16,
    lineHeight: 20,
    color:      P.amber,
  },
  validationBannerTitle: {
    fontSize:     13,
    fontWeight:   "700",
    color:        "#92400e",
    marginBottom: 2,
  },
  validationBannerBody: {
    fontSize:   12,
    color:      "#b45309",
    lineHeight: 17,
  },

  // ── Step 2 — preview card ─────────────────────────────────────────────────
  previewCard: {
    backgroundColor: P.parchment,
    borderRadius:    16,
    borderWidth:     2,
    padding:         16,
    marginBottom:    8,
  },
  previewHeader: {
    flexDirection: "row",
    alignItems:    "flex-start",
    marginBottom:  12,
  },
  emojiInput: {
    fontSize:        32,
    width:           52,
    height:          52,
    textAlign:       "center",
    borderRadius:    10,
    borderWidth:     1,
    borderColor:     P.purpleBorder,
    backgroundColor: P.white,
    paddingVertical: 4,
  },
  emojiInputSmall: {
    fontSize:        24,
    width:           40,
    height:          40,
    textAlign:       "center",
    borderRadius:    8,
    borderWidth:     1,
    borderColor:     P.purpleBorder,
    backgroundColor: P.white,
    paddingVertical: 4,
  },
  previewFieldLabel: { fontSize: 10, color: P.inkFaint, marginBottom: 3, marginTop: 6 },
  previewNameInput: {
    fontSize:          16,
    fontWeight:        "700",
    color:             P.inkBrown,
    borderBottomWidth: 1,
    borderBottomColor: P.warmBorder,
    paddingVertical:   3,
  },
  previewSubInput: {
    fontSize:          14,
    color:             P.inkBrown,
    borderWidth:       1,
    borderColor:       P.warmBorder,
    borderRadius:      8,
    paddingHorizontal: 10,
    paddingVertical:   7,
    backgroundColor:   P.parchment,
  },
  spellRow: {
    flexDirection: "row",
    alignItems:    "center",
    marginTop:     10,
  },
  badgeRow: {
    flexDirection: "row",
    marginTop:     12,
    gap:           8,
  },
  badge: {
    borderWidth:       1,
    borderRadius:      20,
    paddingHorizontal: 10,
    paddingVertical:   4,
  },
  badgeText: { fontSize: 11, fontWeight: "700" },

  // ── Properties section header ─────────────────────────────────────────────
  propSectionHeader: {
    flexDirection:  "row",
    alignItems:     "flex-start",
    justifyContent: "space-between",
    marginTop:      20,
    marginBottom:   4,
  },
  propCountBadge: {
    paddingVertical:   3,
    paddingHorizontal: 11,
    borderRadius:      12,
    backgroundColor:   P.parchment,
    borderWidth:       1,
    borderColor:       P.warmBorder,
    marginTop:         2,
  },
  propCountBadgeFull: {
    backgroundColor: "#fef3c7",
    borderColor:     "#f59e0b",
  },
  propCountBadgeText: {
    fontSize:   12,
    fontWeight: "700",
    color:      P.inkMid,
  },
  propHint: {
    fontSize:     12,
    color:        P.inkLight,
    lineHeight:   17,
    marginBottom: 10,
  },

  // ── Property editor card ──────────────────────────────────────────────────
  propEditor: {
    backgroundColor: P.parchment,
    borderRadius:    12,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    padding:         14,
    marginBottom:    12,
  },
  // Amber variant when this word is already in the child's Tome
  propEditorFlagged: {
    borderColor:     P.amberBorder,
    borderWidth:     1.5,
    backgroundColor: P.amberLight,
  },
  propHeader: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    marginBottom:   6,
  },
  propIndex:      { fontSize: 12, fontWeight: "700", color: P.purple },

  // "Already in Tome" badge inside a flagged property card
  flaggedBadge: {
    backgroundColor:   "#fef3c7",
    borderRadius:      6,
    paddingHorizontal: 7,
    paddingVertical:   2,
    marginRight:       "auto",  // push delete button to far right
    marginLeft:        8,
  },
  flaggedBadgeText: {
    fontSize:   11,
    color:      P.amber,
    fontWeight: "600",
  },

  propDeleteBtn: {
    paddingVertical:   3,
    paddingHorizontal: 10,
    borderRadius:      8,
    backgroundColor:   "#fee2e2",
  },
  propDeleteText: { fontSize: 12, fontWeight: "600", color: "#dc2626" },
  propFieldLabel: { fontSize: 11, color: P.inkFaint, marginBottom: 4, marginTop: 8 },
  propInput: {
    backgroundColor:   P.white,
    borderRadius:      8,
    borderWidth:       1,
    borderColor:       P.warmBorder,
    paddingHorizontal: 10,
    paddingVertical:   8,
    fontSize:          14,
    color:             P.inkBrown,
    textAlignVertical: "top",
  },

  // Add property button
  addPropBtn: {
    borderWidth:     1.5,
    borderColor:     P.purple,
    borderStyle:     "dashed",
    borderRadius:    12,
    paddingVertical: 13,
    alignItems:      "center",
    marginTop:       4,
    marginBottom:    10,
  },
  addPropBtnText: { fontSize: 14, fontWeight: "600", color: P.purple },

  // Save / regen buttons
  saveBtn: {
    backgroundColor: P.amber,
    borderRadius:    14,
    paddingVertical: 15,
    alignItems:      "center",
    marginTop:       20,
  },
  saveBtnText: { color: P.white, fontSize: 16, fontWeight: "700" },
  regenBtn: {
    borderWidth:     1,
    borderColor:     P.warmBorder,
    borderRadius:    14,
    paddingVertical: 12,
    alignItems:      "center",
    marginTop:       10,
  },
  regenBtnText: { fontSize: 14, fontWeight: "600", color: P.inkMid },

  // Generating overlay
  generatingWrap: {
    flex:           1,
    alignItems:     "center",
    justifyContent: "center",
    padding:        32,
  },
  generatingEmoji: { fontSize: 64 },
  generatingTitle: {
    fontSize:     20,
    fontWeight:   "700",
    color:        P.inkBrown,
    marginTop:    20,
    textAlign:    "center",
  },
  generatingTheme: {
    fontSize:     15,
    color:        P.purple,
    fontStyle:    "italic",
    marginTop:    8,
    textAlign:    "center",
  },
  generatingNote: {
    fontSize:   13,
    color:      P.inkLight,
    marginTop:  10,
    textAlign:  "center",
    lineHeight: 18,
  },

  // Step 3 — success
  successWrap:  { alignItems: "center", justifyContent: "center", flex: 1 },
  successEmoji: { fontSize: 72, marginBottom: 16 },
  successTitle: {
    fontSize:     26,
    fontWeight:   "800",
    color:        P.inkBrown,
    marginBottom: 8,
  },
  successSub: {
    fontSize:     15,
    color:        P.inkMid,
    textAlign:    "center",
    lineHeight:   22,
    marginBottom: 20,
    paddingHorizontal: 8,
  },
  successCard: {
    width:             "100%",
    backgroundColor:   P.greenLight,
    borderRadius:      16,
    borderWidth:       1,
    padding:           16,
    marginBottom:      24,
    alignItems:        "center",
  },
  successSpell: { fontSize: 18, fontWeight: "700", color: P.inkBrown, marginBottom: 4 },
  successRoom:  { fontSize: 14, color: P.inkLight, marginBottom: 12 },
  successWords: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "center" },
  wordPill: {
    backgroundColor:   P.parchment,
    borderRadius:      20,
    borderWidth:       1,
    borderColor:       P.warmBorder,
    paddingVertical:   4,
    paddingHorizontal: 12,
  },
  wordPillText: { fontSize: 13, fontWeight: "600", color: P.inkBrown },
  doneBtn: {
    backgroundColor: P.amber,
    borderRadius:    14,
    paddingVertical: 14,
    paddingHorizontal: 40,
    marginBottom:    12,
  },
  doneBtnText:    { color: P.white, fontSize: 16, fontWeight: "700" },
  anotherBtn:     { paddingVertical: 8 },
  anotherBtnText: { fontSize: 14, fontWeight: "600", color: P.purple },
});
