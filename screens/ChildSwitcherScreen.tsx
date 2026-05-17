/**
 * ChildSwitcherScreen.tsx
 * Lexi-Lens — choose which child is playing (or add a new one).
 *
 * v2.1 change: age_band replaced with exact age (5–12).
 *   • age_band derived server-side via DB trigger (sync_age_band)
 *
 * UI change (this revision): the age picker is now a single dropdown
 * (cross-platform Modal list — identical on iOS and Android, no native
 * Picker dependency) instead of a row of 8 tiles. There is intentionally
 * NO separate "proficiency" input: the app has no proficiency column —
 * reading level is DERIVED from age by the server-side sync_age_band
 * trigger. Surfacing it as a read-only line that tracks the chosen age
 * keeps the UI honest and avoids dead, contradictory data. (Adding an
 * independent proficiency picker would fight the v6.1 "capture actual
 * age precisely" design and the trigger.)
 *
 * N1 change: handleSelect checks hasSeenOnboarding and routes to onboarding
 * on first launch instead of jumping straight to QuestMap.
 *
 * N2 fix (TS2345): handleSignOut no longer calls navigation.replace("Auth").
 *   Auth routing is handled by App.tsx onAuthStateChange when session clears.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  TextInput,
  Animated,
  ActivityIndicator,
  Alert,
  Platform,
  Modal,
} from "react-native";
import { useSafeAreaInsets }  from "react-native-safe-area-context";
import * as Haptics           from "expo-haptics";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import { supabase, signOut }  from "../lib/supabase";
import { ParentPinGateModal } from "../components/ParentPinGateModal";
import { useGameStore }       from "../store/gameStore";

// ─── Navigation types ─────────────────────────────────────────────────────────

import type { RootStackParamList } from "../types/navigation";
type Props = NativeStackScreenProps<RootStackParamList, "ChildSwitcher">;

// ─── Constants ────────────────────────────────────────────────────────────────

// Actual ages (5-12). The model and DB store the actual integer age. The
// age_band column in DB is derived server-side via the sync_age_band trigger.
//
// Why integers and not bands: Mistral's kid_msg.young/older split fires at
// age<8 → young, age≥8 → older. A 7-year-old picked as part of the "7-8"
// band used to be sent to the model as age=8, flipping their voice register
// to "older". Capturing actual age fixes this and lets future tuning tighten
// the threshold without a UI change.
const AGE_OPTIONS = [
  { age: 5,  bandLabel: "Early reader" },
  { age: 6,  bandLabel: "Early reader" },
  { age: 7,  bandLabel: "Developing"   },
  { age: 8,  bandLabel: "Developing"   },
  { age: 9,  bandLabel: "Advancing"    },
  { age: 10, bandLabel: "Advancing"    },
  { age: 11, bandLabel: "Proficient"   },
  { age: 12, bandLabel: "Proficient"   },
] as const;

// Reading level shown to the parent is DERIVED from age using the same
// thresholds the server uses (sync_age_band: ≤6 → 5-6, ≤8 → 7-8, ≤10 → 9-10,
// else 11-12). This is display-only and read-only — it is not stored or sent;
// the server re-derives age_band from `age` on insert. Kept in lockstep with
// the DB trigger so the label never lies about what the child will get.
function readingLevelForAge(age: number): { band: string; label: string } {
  if (age <= 6)  return { band: "5-6",   label: "Early reader" };
  if (age <= 8)  return { band: "7-8",   label: "Developing"   };
  if (age <= 10) return { band: "9-10",  label: "Advancing"    };
  return { band: "11-12", label: "Proficient" };
}

const AVATAR_OPTIONS = [
  { key: "wizard",  emoji: "🧙", label: "Wizard" },
  { key: "knight",  emoji: "⚔️", label: "Knight" },
  { key: "archer",  emoji: "🏹", label: "Archer" },
  { key: "dragon",  emoji: "🐉", label: "Dragon" },
] as const;

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
  white:        "#ffffff",
  danger:       "#dc2626",
  dangerLight:  "#fef2f2",
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChildRow {
  id:           string;
  display_name: string;
  age:          number;   // v6.1 — selected from child_profiles.age, passed into ChildSession
  age_band:     string;
  level:        number;
  total_xp:     number;
  avatar_key:   string | null;
}

// ─── Avatar helper ────────────────────────────────────────────────────────────

const AVATAR_EMOJIS: Record<string, string> = {
  wizard:  "🧙",
  knight:  "⚔️",
  archer:  "🏹",
  dragon:  "🐉",
  default: "✦",
};

// ─── ChildCard ────────────────────────────────────────────────────────────────

interface ChildCardProps {
  child:    ChildRow;
  onSelect: () => void;
  onDelete: () => void;
}

function ChildCard({ child, onSelect, onDelete }: ChildCardProps) {
  const emoji = AVATAR_EMOJIS[child.avatar_key ?? "default"] ?? "✦";

  return (
    <TouchableOpacity
      style={styles.childCard}
      onPress={onSelect}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`Play as ${child.display_name}, level ${child.level}`}
    >
      <View style={styles.childCardAvatar}>
        <Text style={styles.childCardAvatarEmoji}>{emoji}</Text>
      </View>
      <View style={styles.childCardInfo}>
        <Text style={styles.childCardName}>{child.display_name}</Text>
        <Text style={styles.childCardMeta}>
          Level {child.level} · {child.total_xp} XP · Age {child.age_band}
        </Text>
      </View>
      <TouchableOpacity
        style={styles.deleteBtn}
        onPress={onDelete}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        accessibilityLabel={`Remove ${child.display_name}`}
      >
        <Text style={styles.deleteBtnText}>✕</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

// ─── AddChildForm ─────────────────────────────────────────────────────────────

interface AddChildFormProps {
  onSaved:  () => void;
  onCancel: () => void;
}

function AddChildForm({ onSaved, onCancel }: AddChildFormProps) {
  const [name,        setName]        = useState("");
  // No default — parent must actively pick an age. This prevents the
  // pre-v6.1 bug where every child silently got age=8 because that was
  // the form's hardcoded initial value.
  const [age,         setAge]         = useState<number | null>(null);
  const [avatarKey,   setAvatarKey]   = useState<string>("wizard");
  const [ageMenuOpen, setAgeMenuOpen] = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError("Please enter a display name."); return; }
    if (age === null) { setError("Please pick the child's age."); return; }
    setSaving(true);
    setError(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");

      // Insert with actual `age` only. The sync_age_band trigger derives
      // age_band from age automatically; we don't need to supply it.
      const { error: insertErr } = await supabase
        .from("child_profiles")
        .insert({
          parent_id:    user.id,
          display_name: trimmed,
          age,
          avatar_key:   avatarKey,
        });

      if (insertErr) throw insertErr;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSaved();
    } catch (err: any) {
      setError(err.message ?? "Could not save profile");
    } finally {
      setSaving(false);
    }
  };

  const derived = age !== null ? readingLevelForAge(age) : null;

  return (
    <View style={styles.addForm}>
      <Text style={styles.addFormTitle}>Add a child</Text>

      {error && <Text style={styles.addFormError}>{error}</Text>}

      <TextInput
        style={styles.addFormInput}
        placeholder="Display name (e.g. Anya)"
        placeholderTextColor={P.inkFaint}
        value={name}
        onChangeText={setName}
        maxLength={30}
        autoFocus
      />

      {/* Age — single dropdown (cross-platform Modal list) */}
      <Text style={styles.addFormLabel}>Age</Text>
      <TouchableOpacity
        style={[styles.dropdown, age !== null && styles.dropdownFilled]}
        onPress={() => { setAgeMenuOpen(true); Haptics.selectionAsync(); }}
        accessibilityRole="button"
        accessibilityLabel={age === null ? "Select age" : `Age ${age}, change`}
      >
        <Text style={[styles.dropdownText, age === null && styles.dropdownPlaceholder]}>
          {age === null ? "Select age (5–12)" : `${age} years old`}
        </Text>
        <Text style={styles.dropdownCaret}>▾</Text>
      </TouchableOpacity>

      {/* Reading level — derived, read-only. Tracks the chosen age. */}
      <View style={styles.derivedRow}>
        <Text style={styles.derivedLabel}>Reading level</Text>
        <Text style={styles.derivedValue}>
          {derived ? `${derived.label} · band ${derived.band}` : "—"}
        </Text>
      </View>
      <Text style={styles.derivedHint}>
        Set automatically from age — tunes word difficulty and Lumi's voice.
      </Text>

      {/* Avatar */}
      <Text style={[styles.addFormLabel, { marginTop: 18 }]}>Avatar</Text>
      <View style={styles.avatarRow}>
        {AVATAR_OPTIONS.map((a) => (
          <TouchableOpacity
            key={a.key}
            style={[styles.avatarChip, avatarKey === a.key && styles.avatarChipActive]}
            onPress={() => { setAvatarKey(a.key); Haptics.selectionAsync(); }}
          >
            <Text style={styles.avatarEmoji}>{a.emoji}</Text>
            <Text style={[styles.avatarLabel, avatarKey === a.key && styles.avatarLabelActive]}>{a.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Buttons */}
      <View style={styles.addFormButtons}>
        <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.saveBtn, (saving || age === null) && { opacity: 0.7 }]}
          onPress={handleSave}
          disabled={saving || age === null}
        >
          {saving
            ? <ActivityIndicator color={P.white} size="small" />
            : <Text style={styles.saveBtnText}>Save</Text>
          }
        </TouchableOpacity>
      </View>

      {/* Age dropdown sheet — identical behaviour iOS & Android */}
      <Modal
        visible={ageMenuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setAgeMenuOpen(false)}
      >
        <TouchableOpacity
          style={styles.modalScrim}
          activeOpacity={1}
          onPress={() => setAgeMenuOpen(false)}
        >
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Select age</Text>
            <ScrollView
              style={styles.modalList}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {AGE_OPTIONS.map((opt) => {
                const selected = age === opt.age;
                return (
                  <TouchableOpacity
                    key={opt.age}
                    style={[styles.modalRow, selected && styles.modalRowActive]}
                    onPress={() => {
                      setAge(opt.age);
                      setAgeMenuOpen(false);
                      Haptics.selectionAsync();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Age ${opt.age}, ${opt.bandLabel}`}
                  >
                    <Text style={[styles.modalRowAge, selected && styles.modalRowAgeActive]}>
                      {opt.age} years
                    </Text>
                    <Text style={[styles.modalRowBand, selected && styles.modalRowBandActive]}>
                      {opt.bandLabel}
                    </Text>
                    {selected && <Text style={styles.modalRowCheck}>✓</Text>}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export function ChildSwitcherScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();

  const [children,   setChildren]   = useState<ChildRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [showForm,   setShowForm]   = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [parentId,   setParentId]   = useState("");
  const [parentEmail, setParentEmail] = useState("");
  const [pinVisible, setPinVisible] = useState(false);

  const {
    startChildSession,
    loadQuests,
    loadCompletedQuests,
    hasSeenOnboarding,
  } = useGameStore();

  // ── Fetch children ─────────────────────────────────────────────────────────

  const fetchChildren = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("child_profiles")
        .select("id, display_name, age, age_band, level, total_xp, avatar_key")
        .order("created_at", { ascending: true });

      if (error) throw error;
      setChildren(data ?? []);
    } catch (err: any) {
      Alert.alert("Error", err.message ?? "Could not load profiles");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchChildren(); }, [fetchChildren]);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        setParentId(user.id);
        setParentEmail(user.email ?? "");
      }
    });
  }, []);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleSelect = useCallback(async (child: ChildRow) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    startChildSession({
      id:           child.id,
      display_name: child.display_name,
      age:          child.age,
      age_band:     child.age_band,
      level:        child.level,
      total_xp:     child.total_xp,
      avatar_key:   child.avatar_key,
    });
    await Promise.all([loadQuests(), loadCompletedQuests()]);

    // N1: route to onboarding on first launch, QuestMap thereafter
    if (!hasSeenOnboarding) {
      navigation.navigate("Onboarding");
    } else {
      navigation.navigate("QuestMap");
    }
  }, [startChildSession, loadQuests, loadCompletedQuests, navigation, hasSeenOnboarding]);

  const handleDelete = useCallback((id: string) => {
    Alert.alert(
      "Remove child?",
      "This removes all data for this child profile. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text:    "Remove",
          style:   "destructive",
          onPress: async () => {
            await supabase.from("child_profiles").delete().eq("id", id);
            fetchChildren();
          },
        },
      ]
    );
  }, [fetchChildren]);

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await signOut();
      // App.tsx onAuthStateChange listener fires when the session clears,
      // switching the root navigator from <AppNavigator> to <AuthNavigator>
      // automatically. No manual navigation call is valid or needed here.
    } catch {
      setSigningOut(false);
    }
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Who's playing?</Text>
          <Text style={styles.headerSub}>Select a child to begin</Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.dashboardBtn}
            onPress={() => setPinVisible(true)}
            accessibilityLabel="Parent dashboard"
          >
            <Text style={styles.dashboardBtnText}>📊 Word Tome</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.signOutBtn}
            onPress={handleSignOut}
            disabled={signingOut}
            accessibilityRole="button"
            accessibilityLabel="Sign out"
          >
            {signingOut
              ? <ActivityIndicator color={P.inkLight} size="small" />
              : <Text style={styles.signOutText}>Sign out</Text>
            }
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 32 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={P.amber} />
          </View>
        ) : (
          <>
            {children.length === 0 && !showForm && (
              <View style={styles.emptyState}>
                <Text style={styles.emptyEmoji}>👧🧒</Text>
                <Text style={styles.emptyTitle}>No children added yet</Text>
                <Text style={styles.emptyDesc}>
                  Add a child profile to start their vocabulary adventure.
                </Text>
              </View>
            )}

            {children.map((child) => (
              <ChildCard
                key={child.id}
                child={child}
                onSelect={() => handleSelect(child)}
                onDelete={() => handleDelete(child.id)}
              />
            ))}

            <ParentPinGateModal
              visible={pinVisible}
              parentId={parentId}
              parentEmail={parentEmail}
              onSuccess={() => {
                setPinVisible(false);
                navigation.navigate("ParentDashboard");
              }}
              onDismiss={() => setPinVisible(false)}
            />

            {showForm ? (
              <AddChildForm
                onSaved={() => { setShowForm(false); fetchChildren(); }}
                onCancel={() => setShowForm(false)}
              />
            ) : (
              <TouchableOpacity
                style={styles.addChildBtn}
                onPress={() => {
                  setShowForm(true);
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }}
                accessibilityRole="button"
                accessibilityLabel="Add a child profile"
              >
                <Text style={styles.addChildBtnPlus}>+</Text>
                <Text style={styles.addChildBtnText}>Add a child</Text>
              </TouchableOpacity>
            )}

            {!showForm && (
              <Text style={styles.coppaNote}>
                🔒 Child profiles use a display name and age only — no email or date of birth
                is stored for children, in accordance with COPPA.
              </Text>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: P.cream },
  center: { paddingVertical: 60, alignItems: "center" },
  scroll: { paddingHorizontal: 20, paddingTop: 8 },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 20,
    paddingBottom:     12,
    borderBottomWidth: 1,
    borderBottomColor: P.warmBorder,
  },
  headerTitle: { fontSize: 22, fontWeight: "800", color: P.inkBrown, letterSpacing: -0.3 },
  headerSub:   { fontSize: 13, color: P.inkLight, marginTop: 2 },

  headerActions: { flexDirection: "row", alignItems: "center" },

  dashboardBtn: {
    backgroundColor:   P.purpleLight,
    borderRadius:      20,
    paddingHorizontal: 10,
    paddingVertical:   7,
    borderWidth:       1,
    borderColor:       P.purpleBorder,
    marginRight:       8,
  },
  dashboardBtnText: { color: P.purple, fontSize: 12, fontWeight: "700" },

  signOutBtn: { paddingVertical: 8, paddingHorizontal: 4 },
  signOutText: { fontSize: 14, color: P.inkLight, fontWeight: "500" },

  // Child card
  childCard: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: P.white,
    borderRadius:    16,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    marginTop:       12,
    overflow:        "hidden",
    ...Platform.select({
      ios:     { shadowColor: P.inkBrown, shadowOpacity: 0.07, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
      android: { elevation: 2 },
    }),
  },
  childCardAvatar: {
    width:           60,
    height:          60,
    backgroundColor: P.amberLight,
    alignItems:      "center",
    justifyContent:  "center",
  },
  childCardAvatarEmoji: { fontSize: 28 },
  childCardInfo:   { flex: 1, paddingHorizontal: 14 },
  childCardName:   { fontSize: 17, fontWeight: "700", color: P.inkBrown },
  childCardMeta:   { fontSize: 12, color: P.inkLight, marginTop: 3 },
  deleteBtn:       { padding: 16 },
  deleteBtnText:   { fontSize: 14, color: P.inkFaint },

  // Empty state
  emptyState: { alignItems: "center", paddingVertical: 48 },
  emptyEmoji: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: P.inkBrown, marginBottom: 6 },
  emptyDesc:  { fontSize: 14, color: P.inkLight, textAlign: "center", lineHeight: 20 },

  // Add child
  addChildBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "center",
    gap:               8,
    marginTop:         16,
    backgroundColor:   P.amberLight,
    borderRadius:      14,
    borderWidth:       1,
    borderStyle:       "dashed",
    borderColor:       P.amberBorder,
    paddingVertical:   16,
  },
  addChildBtnPlus: { fontSize: 22, color: P.amber, fontWeight: "300" },
  addChildBtnText: { fontSize: 15, color: P.amber, fontWeight: "600" },

  // COPPA note
  coppaNote: {
    fontSize:     11,
    color:        P.inkFaint,
    textAlign:    "center",
    lineHeight:   16,
    marginTop:    20,
    paddingHorizontal: 20,
  },

  // Add form
  addForm: {
    backgroundColor: P.parchment,
    borderRadius:    16,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    padding:         20,
    marginTop:       16,
  },
  addFormTitle: { fontSize: 17, fontWeight: "700", color: P.inkBrown, marginBottom: 14 },
  addFormError: { fontSize: 13, color: P.danger, marginBottom: 10, backgroundColor: P.dangerLight, padding: 10, borderRadius: 8 },
  addFormInput: {
    backgroundColor:   P.white,
    borderRadius:      10,
    borderWidth:       1,
    borderColor:       P.warmBorder,
    paddingHorizontal: 14,
    paddingVertical:   11,
    fontSize:          15,
    color:             P.inkBrown,
    marginBottom:      16,
  },
  addFormLabel: { fontSize: 13, fontWeight: "600", color: P.inkMid, marginBottom: 8 },

  // Dropdown trigger (age)
  dropdown: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    backgroundColor:   P.white,
    borderRadius:      10,
    borderWidth:       1,
    borderColor:       P.warmBorder,
    paddingHorizontal: 14,
    paddingVertical:   13,
  },
  dropdownFilled:      { borderColor: P.amber, backgroundColor: P.amberLight },
  dropdownText:        { fontSize: 15, fontWeight: "600", color: P.inkBrown },
  dropdownPlaceholder: { color: P.inkFaint, fontWeight: "500" },
  dropdownCaret:       { fontSize: 14, color: P.inkLight, marginLeft: 8 },

  // Derived reading level (read-only)
  derivedRow: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "space-between",
    marginTop:       12,
    paddingHorizontal: 4,
  },
  derivedLabel: { fontSize: 13, fontWeight: "600", color: P.inkMid },
  derivedValue: { fontSize: 13, fontWeight: "700", color: P.amber },
  derivedHint:  { fontSize: 11, color: P.inkFaint, marginTop: 4, paddingHorizontal: 4, lineHeight: 15 },

  // Age dropdown modal
  modalScrim: {
    flex:            1,
    backgroundColor: "rgba(61,42,15,0.45)",
    justifyContent:  "center",
    alignItems:      "center",
    paddingHorizontal: 28,
  },
  modalSheet: {
    width:           "100%",
    maxWidth:        360,
    maxHeight:       "70%",
    backgroundColor: P.cream,
    borderRadius:    18,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    paddingVertical: 16,
    paddingHorizontal: 16,
    ...Platform.select({
      ios:     { shadowColor: P.inkBrown, shadowOpacity: 0.18, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } },
      android: { elevation: 8 },
    }),
  },
  modalTitle: { fontSize: 16, fontWeight: "800", color: P.inkBrown, marginBottom: 10, paddingHorizontal: 4 },
  modalList:  { flexGrow: 0 },
  modalRow: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingVertical:   13,
    paddingHorizontal: 14,
    borderRadius:      10,
    marginBottom:      6,
    borderWidth:       1,
    borderColor:       P.warmBorder,
    backgroundColor:   P.white,
  },
  modalRowActive:      { borderColor: P.amber, backgroundColor: P.amberLight },
  modalRowAge:         { fontSize: 15, fontWeight: "700", color: P.inkBrown },
  modalRowAgeActive:   { color: P.amber },
  modalRowBand:        { fontSize: 13, color: P.inkLight, marginLeft: 10, flex: 1 },
  modalRowBandActive:  { color: P.inkMid },
  modalRowCheck:       { fontSize: 16, fontWeight: "800", color: P.amber, marginLeft: 8 },

  // Legacy chip styles retained (no longer used by the age picker; kept to
  // avoid touching unrelated style references).
  chipRow:    { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 },
  chip: {
    backgroundColor:   P.white,
    borderRadius:      10,
    borderWidth:       1,
    borderColor:       P.warmBorder,
    paddingHorizontal: 12,
    paddingVertical:   8,
    alignItems:        "center",
  },
  chipActive: { borderColor: P.amber, backgroundColor: P.amberLight },
  chipLabel:  { fontSize: 13, fontWeight: "600", color: P.inkMid },
  chipLabelActive: { color: P.amber },
  chipDesc:   { fontSize: 11, color: P.inkFaint, marginTop: 2 },
  chipDescActive:  { color: P.inkLight },

  avatarRow: { flexDirection: "row", gap: 8, marginBottom: 20 },
  avatarChip: {
    flex:            1,
    alignItems:      "center",
    paddingVertical: 10,
    borderRadius:    10,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    backgroundColor: P.white,
  },
  avatarChipActive: { borderColor: P.amber, backgroundColor: P.amberLight },
  avatarEmoji:      { fontSize: 22, marginBottom: 4 },
  avatarLabel:      { fontSize: 11, color: P.inkLight, fontWeight: "600" },
  avatarLabelActive:{ color: P.amber },

  addFormButtons: { flexDirection: "row", gap: 10, marginTop: 4 },
  cancelBtn: {
    flex:            1,
    paddingVertical: 13,
    alignItems:      "center",
    borderRadius:    10,
    borderWidth:     1,
    borderColor:     P.warmBorder,
  },
  cancelBtnText: { fontSize: 15, color: P.inkLight, fontWeight: "600" },
  saveBtn: {
    flex:            1,
    paddingVertical: 13,
    alignItems:      "center",
    borderRadius:    10,
    backgroundColor: P.amber,
  },
  saveBtnText: { fontSize: 15, color: P.white, fontWeight: "700" },
});
