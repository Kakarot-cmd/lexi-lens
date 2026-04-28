/**
 * QuestGeneratorScreen.tsx — Lexi-Lens Phase 3.3
 * AI Quest Generator for parents.
 *
 * Rendered as a full-screen Modal from ParentDashboard — no navigator needed.
 *
 * Flow:
 *   Step 1 — INPUT:   Parent types a theme, picks age band + tier → Generate
 *   Step 2 — PREVIEW: Editable quest card — name, enemy, room, 3 properties → Save
 *   Step 3 — SAVED:   Success screen with a link to see it in the Dungeon Map
 *
 * The saved quest appears in the child's QuestMap immediately
 * (visibility: 'private', created_by: parent uid).
 *
 * Dependencies (all already in project):
 *   @supabase/supabase-js, react-native-reanimated, expo-haptics
 */

import React, { useState, useRef, useCallback } from "react";
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
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  Easing,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { supabase }  from "../lib/supabase";

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

// ─── Generated quest type ─────────────────────────────────────────────────────

interface PropertyRequirement {
  word:            string;
  definition:      string;
  evaluationHints: string;
}

interface GeneratedQuest {
  name:                string;
  enemy_name:          string;
  enemy_emoji:         string;
  room_label:          string;
  spell_name:          string;
  weapon_emoji:        string;
  spell_description:   string;
  required_properties: PropertyRequirement[];
  hard_mode_properties?: PropertyRequirement[];  // taxonomy-generated upward synonyms
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface TargetChild {
  id:           string;
  display_name: string;
  age_band:     string;
}

interface Props {
  visible:       boolean;
  onClose:       () => void;
  defaultAgeBand?: AgeBand;
  /** If set, quest is created just for this child. Null = all children. */
  targetChild?:  TargetChild | null;
}

// ─── Step 1: Theme input ──────────────────────────────────────────────────────

function StepInput({
  onGenerate,
  defaultAgeBand,
  targetChild,
  forAllChildren,
  setForAllChildren,
}: {
  onGenerate:        (theme: string, ageBand: AgeBand, tier: Tier) => void;
  defaultAgeBand:    AgeBand;
  targetChild:       TargetChild | null;
  forAllChildren:    boolean;
  setForAllChildren: (v: boolean) => void;
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

        {/* Age band */}
        <Text style={[styles.fieldLabel, { marginTop: 18 }]}>Child's age range</Text>
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
        <Text style={[styles.fieldLabel, { marginTop: 18 }]}>Difficulty tier</Text>
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
            onGenerate(theme.trim(), ageBand, tier);
          }}
        >
          <Text style={styles.generateBtnText}>✦ Generate Quest with AI</Text>
        </TouchableOpacity>

        {/* Child targeting — only shown when a specific child was selected */}
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
}: {
  prop:     PropertyRequirement;
  index:    number;
  onChange: (updated: PropertyRequirement) => void;
}) {
  return (
    <View style={styles.propEditor}>
      <Text style={styles.propIndex}>Property {index + 1}</Text>
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
}: {
  quest:        GeneratedQuest;
  ageBand:      AgeBand;
  tier:         Tier;
  onSave:       (q: GeneratedQuest) => void;
  onRegenerate: () => void;
  saving:       boolean;
}) {
  const [quest, setQuest] = useState<GeneratedQuest>(initial);
  const color = TIER_COLOR[tier];

  const updateProp = (i: number, updated: PropertyRequirement) => {
    const props = [...quest.required_properties];
    props[i] = updated;
    setQuest({ ...quest, required_properties: props });
  };

  return (
    <ScrollView
      contentContainerStyle={styles.stepPad}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.stepTitle}>📜 Preview Your Quest</Text>
      <Text style={styles.stepSub}>Edit any field before saving to your child's dungeon.</Text>

      {/* Quest identity card */}
      <View style={[styles.previewCard, { borderColor: color }]}>
        {/* Enemy + name row */}
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

        {/* Tier + age badge */}
        <View style={styles.badgeRow}>
          <View style={[styles.badge, { borderColor: color }]}>
            <Text style={[styles.badgeText, { color }]}>
              {TIERS.find((t) => t.key === tier)?.emoji} {tier.charAt(0).toUpperCase() + tier.slice(1)}
            </Text>
          </View>
          <View style={[styles.badge, { borderColor: P.amber }]}>
            <Text style={[styles.badgeText, { color: P.amber }]}>Age {ageBand}</Text>
          </View>
        </View>
      </View>

      {/* Properties */}
      <Text style={[styles.fieldLabel, { marginTop: 20, marginBottom: 4 }]}>Vocabulary properties</Text>
      <Text style={styles.propHint}>
        These are the words your child will learn by scanning household objects.
      </Text>
      {quest.required_properties.map((p, i) => (
        <PropertyEditor key={i} prop={p} index={i} onChange={(u) => updateProp(i, u)} />
      ))}

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
        {" "}is now live in {targetChild && !forAllChildren ? `${targetChild.display_name}'s` : "your children's"} Dungeon Map.
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

export default function QuestGeneratorScreen({ visible, onClose, defaultAgeBand = "7-8", targetChild }: Props) {
  const [step,          setStep]          = useState<Step>("input");
  const [theme,         setTheme]         = useState("");
  const [ageBand,       setAgeBand]       = useState<AgeBand>(defaultAgeBand);
  const [tier,          setTier]          = useState<Tier>("apprentice");
  const [generated,     setGenerated]     = useState<GeneratedQuest | null>(null);
  const [savedQuest,    setSavedQuest]    = useState<GeneratedQuest | null>(null);
  const [saving,        setSaving]        = useState(false);
  const [error,         setError]         = useState<string | null>(null);
  const [forAllChildren,setForAllChildren]= useState(!targetChild);  // true = all, false = specific child

  const reset = useCallback(() => {
    setStep("input");
    setTheme("");
    setGenerated(null);
    setSavedQuest(null);
    setError(null);
    setSaving(false);
    setForAllChildren(!targetChild);
  }, [targetChild]);

  // ── Call Edge Function ────────────────────────────────
  const handleGenerate = useCallback(async (
    inputTheme: string,
    inputBand:  AgeBand,
    inputTier:  Tier,
  ) => {
    setTheme(inputTheme);
    setAgeBand(inputBand);
    setTier(inputTier);
    setStep("generating");
    setError(null);

    try {
      // ── Fetch child's word_tome for uniqueness + mastery context ────────────
      // If a specific child is targeted, fetch their vocabulary.
      // If generating for all children, skip (no single mastery profile to use).
      let knownWords:    string[] = [];
      let masteryProfile: Array<{
        word:        string;
        mastery:     number;
        masteryTier: string;
        timesUsed:   number;
      }> = [];

      const childId = targetChild?.id ?? null;
      if (childId) {
        const { data: tomeData } = await supabase
          .from("word_tome")
          .select("word, mastery_score, times_used")
          .eq("child_id", childId);

        if (tomeData && tomeData.length > 0) {
          knownWords = tomeData.map((r: any) => r.word as string);

          // Build mastery profile matching the MasteryEntry shape
          masteryProfile = tomeData.map((r: any) => {
            const score: number = r.mastery_score ?? 0;
            const tier =
              score >= 0.8 ? "expert"
              : score >= 0.6 ? "proficient"
              : score >= 0.3 ? "developing"
              : "novice";
            return {
              word:        r.word,
              mastery:     Math.round(score * 100) / 100,
              masteryTier: tier,
              timesUsed:   r.times_used ?? 1,
            };
          });
        }
      }

      // Use supabase.functions.invoke() — handles JWT automatically, avoids
      // UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM from the Edge Runtime
      const { data, error: fnError } = await supabase.functions.invoke("generate-quest", {
        body: {
          theme:         inputTheme,
          ageBand:       inputBand,
          tier:          inputTier,
          knownWords,
          masteryProfile,
        },
      });

      if (fnError) throw new Error(fnError.message ?? "Generation failed");
      if (!data?.quest) throw new Error("No quest returned from AI");

      setGenerated(data.quest);
      setStep("preview");
    } catch (err: any) {
      setError(err.message ?? "Something went wrong");
      setStep("input");
      Alert.alert("Generation failed", err.message ?? "Please try again.");
    }
  }, [targetChild]);

  // ── Save to Supabase ──────────────────────────────────
  const handleSave = useCallback(async (quest: GeneratedQuest) => {
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");

      const { error: insertErr } = await supabase.from("quests").insert({
        name:                quest.name,
        enemy_name:          quest.enemy_name,
        enemy_emoji:         quest.enemy_emoji,
        room_label:          quest.room_label,
        min_age_band:        ageBand,
        tier:                tier,
        sort_order:          8,
        xp_reward_first_try: 40,
        xp_reward_retry:     20,
        required_properties: quest.required_properties,
        hard_mode_properties: quest.hard_mode_properties ?? [],
        age_band_properties: {},
        spell_name:          quest.spell_name,
        weapon_emoji:        quest.weapon_emoji,
        spell_description:   quest.spell_description,
        created_by:          user.id,
        visibility:          "private",
        is_active:           true,
        // null = visible to all children; uuid = only for that child
        target_child_id:     forAllChildren ? null : (targetChild?.id ?? null),
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
            {step === "input"      ? "AI Quest Creator"   : ""}
            {step === "generating" ? "Creating…"          : ""}
            {step === "preview"    ? "Edit & Save"        : ""}
            {step === "saved"      ? "Quest Ready! 🎉"    : ""}
          </Text>
          {step !== "generating" && (
            <TouchableOpacity
              onPress={step === "saved" ? onClose : step === "preview" ? () => setStep("input") : onClose}
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
                  (step === s || (step === "generating" && s === "input") || (step === "preview" && s === "input"))
                    && styles.stepDotActive,
                  step === "preview" && s === "input" && styles.stepDotDone,
                ]}>
                  <Text style={styles.stepDotText}>{i + 1}</Text>
                </View>
                {i === 0 && <View style={[styles.stepLine, step === "preview" && styles.stepLineDone]} />}
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
          />
        )}
        {step === "generating" && (
          <GeneratingOverlay theme={theme} />
        )}
        {step === "preview" && generated && (
          <StepPreview
            quest={generated}
            ageBand={ageBand}
            tier={tier}
            onSave={handleSave}
            onRegenerate={() => handleGenerate(theme, ageBand, tier)}
            saving={saving}
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
  root: {
    flex:            1,
    backgroundColor: P.cream,
  },

  // Header
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 20,
    paddingTop:        Platform.OS === "ios" ? 16 : 20,
    paddingBottom:     12,
    borderBottomWidth: 1,
    borderBottomColor: P.warmBorder,
    backgroundColor:   P.cream,
  },
  headerTitle:   { fontSize: 18, fontWeight: "700", color: P.inkBrown },
  headerBtn:     { paddingVertical: 4, paddingHorizontal: 4 },
  headerBtnText: { fontSize: 15, color: P.purple, fontWeight: "600" },

  // Step indicator
  stepper: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "center",
    paddingVertical: 12,
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
  stepDotActive: { backgroundColor: P.purple, borderColor: P.purple },
  stepDotDone:   { backgroundColor: P.green,  borderColor: P.green  },
  stepDotText:   { fontSize: 12, fontWeight: "700", color: P.white  },
  stepLine: {
    width:           48,
    height:          2,
    backgroundColor: P.warmBorder,
    marginHorizontal: 6,
  },
  stepLineDone: { backgroundColor: P.green },

  stepPad: {
    paddingHorizontal: 20,
    paddingTop:        12,
    paddingBottom:     40,
  },

  // Step 1
  stepTitle: {
    fontSize:     22,
    fontWeight:   "800",
    color:        P.inkBrown,
    marginBottom: 6,
    letterSpacing:-0.3,
  },
  stepSub: {
    fontSize:     14,
    color:        P.inkLight,
    lineHeight:   20,
    marginBottom: 24,
  },
  fieldLabel: {
    fontSize:     13,
    fontWeight:   "600",
    color:        P.inkMid,
    marginBottom: 8,
  },
  themeInput: {
    backgroundColor:   P.white,
    borderRadius:      12,
    borderWidth:       1,
    borderColor:       P.warmBorder,
    paddingHorizontal: 14,
    paddingVertical:   12,
    fontSize:          15,
    color:             P.inkBrown,
    minHeight:         80,
    textAlignVertical: "top",
  },
  charCount: {
    fontSize:  11,
    color:     P.inkFaint,
    textAlign: "right",
    marginTop: 4,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap:      "wrap",
  },
  chip: {
    width:           "47%",
    alignItems:      "center",
    paddingVertical: 10,
    borderRadius:    10,
    backgroundColor: P.parchment,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    marginRight:     "3%",
    marginBottom:    8,
  },
  chipLabel: { fontSize: 14, fontWeight: "700", color: P.inkMid },
  chipDesc:  { fontSize: 10, color: P.inkFaint, marginTop: 2 },
  tierRow: {
    flexDirection: "row",
    flexWrap:      "wrap",
  },
  tierChip: {
    width:           "47%",
    alignItems:      "center",
    paddingVertical: 10,
    borderRadius:    10,
    backgroundColor: P.parchment,
    borderWidth:     1.5,
    borderColor:     P.warmBorder,
    marginRight:     "3%",
    marginBottom:    8,
  },
  tierEmoji:     { fontSize: 20, marginBottom: 3 },
  tierChipLabel: { fontSize: 13, fontWeight: "700", color: P.inkMid },
  tierChipDesc:  { fontSize: 10, color: P.inkFaint, marginTop: 2 },
  generateBtn: {
    backgroundColor: P.purple,
    borderRadius:    14,
    paddingVertical: 15,
    alignItems:      "center",
    marginTop:       24,
  },
  generateBtnDisabled: { backgroundColor: P.inkFaint },
  generateBtnText: {
    color:      P.white,
    fontSize:   16,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  aiNote: {
    fontSize:  11,
    color:     P.inkFaint,
    textAlign: "center",
    marginTop: 10,
    lineHeight: 16,
  },
  targetRow: {
    flexDirection:  "row",
    alignItems:     "center",
    marginTop:      16,
    marginBottom:   4,
    flexWrap:       "wrap",
  },
  targetLabel: {
    fontSize:    13,
    fontWeight:  "600",
    color:       P.inkMid,
    marginRight: 8,
    marginBottom: 6,
  },
  targetChip: {
    borderWidth:       1,
    borderColor:       P.warmBorder,
    borderRadius:      20,
    paddingHorizontal: 12,
    paddingVertical:   6,
    marginRight:       8,
    marginBottom:      6,
    backgroundColor:   P.parchment,
  },
  targetChipActive: {
    borderColor:     P.purple,
    backgroundColor: P.purpleLight,
  },
  targetChipText:       { fontSize: 12, color: P.inkMid, fontWeight: "600" },
  targetChipTextActive: { color: P.purple },

  // Generating overlay
  generatingWrap: {
    flex:           1,
    alignItems:     "center",
    justifyContent: "center",
    padding:        32,
  },
  generatingEmoji: { fontSize: 56 },
  generatingTitle: {
    fontSize:     18,
    fontWeight:   "700",
    color:        P.inkBrown,
    marginTop:    20,
    textAlign:    "center",
  },
  generatingTheme: {
    fontSize:   14,
    color:      P.purple,
    fontStyle:  "italic",
    marginTop:  8,
    textAlign:  "center",
  },
  generatingNote: {
    fontSize:  12,
    color:     P.inkLight,
    marginTop: 8,
    textAlign: "center",
  },

  // Preview card
  previewCard: {
    backgroundColor: P.white,
    borderRadius:    16,
    borderWidth:     1.5,
    padding:         16,
    marginBottom:    8,
  },
  previewHeader: {
    flexDirection: "row",
    alignItems:    "flex-start",
    marginBottom:  12,
  },
  emojiInput: {
    fontSize:          40,
    width:             56,
    textAlign:         "center",
    backgroundColor:   P.amberLight,
    borderRadius:      12,
    borderWidth:       1,
    borderColor:       P.amberBorder,
    paddingVertical:   4,
  },
  emojiInputSmall: {
    fontSize:        28,
    width:           44,
    textAlign:       "center",
    backgroundColor: P.purpleLight,
    borderRadius:    10,
    borderWidth:     1,
    borderColor:     P.purpleBorder,
    paddingVertical: 4,
  },
  previewFieldLabel: { fontSize: 10, color: P.inkFaint, marginBottom: 3, marginTop: 6 },
  previewNameInput: {
    fontSize:   16,
    fontWeight: "700",
    color:      P.inkBrown,
    borderBottomWidth: 1,
    borderBottomColor: P.warmBorder,
    paddingVertical: 3,
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
  },
  badge: {
    borderWidth:       1,
    borderRadius:      20,
    paddingHorizontal: 10,
    paddingVertical:   4,
    marginRight:       8,
  },
  badgeText: { fontSize: 11, fontWeight: "700" },

  // Property editor
  propEditor: {
    backgroundColor: P.parchment,
    borderRadius:    12,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    padding:         14,
    marginBottom:    12,
  },
  propIndex:       { fontSize: 12, fontWeight: "700", color: P.purple, marginBottom: 8 },
  propFieldLabel:  { fontSize: 11, color: P.inkFaint, marginBottom: 4, marginTop: 8 },
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
  propHint: {
    fontSize:     12,
    color:        P.inkLight,
    marginBottom: 14,
    lineHeight:   17,
  },

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
    alignItems:    "center",
    paddingVertical: 12,
    marginTop:     8,
  },
  regenBtnText: { color: P.purple, fontSize: 14, fontWeight: "600" },

  // Success
  successWrap: {
    flex:           1,
    alignItems:     "center",
    justifyContent: "center",
  },
  successEmoji: { fontSize: 64, marginBottom: 12 },
  successTitle: {
    fontSize:     26,
    fontWeight:   "800",
    color:        P.inkBrown,
    marginBottom: 8,
  },
  successSub: {
    fontSize:   14,
    color:      P.inkLight,
    textAlign:  "center",
    lineHeight: 20,
    marginBottom: 24,
    paddingHorizontal: 16,
  },
  successCard: {
    backgroundColor:   P.greenLight,
    borderRadius:      16,
    borderWidth:       1,
    padding:           20,
    alignItems:        "center",
    width:             "100%",
    marginBottom:      28,
  },
  successSpell: { fontSize: 18, fontWeight: "700", color: P.green, marginBottom: 6 },
  successRoom:  { fontSize: 13, color: P.inkLight, marginBottom: 12 },
  successWords: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center" },
  wordPill: {
    backgroundColor:   P.greenBorder + "40",
    borderRadius:      20,
    paddingHorizontal: 12,
    paddingVertical:   5,
    margin:            4,
    borderWidth:       1,
    borderColor:       P.greenBorder,
  },
  wordPillText: { fontSize: 13, fontWeight: "700", color: P.green },
  doneBtn: {
    backgroundColor: P.amber,
    borderRadius:    14,
    paddingVertical: 14,
    paddingHorizontal: 48,
    marginBottom:    12,
  },
  doneBtnText: { color: P.white, fontSize: 16, fontWeight: "700" },
  anotherBtn: { paddingVertical: 12 },
  anotherBtnText: { color: P.purple, fontSize: 14, fontWeight: "600" },
});
