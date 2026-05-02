/**
 * ChildSwitcherScreen.tsx
 * Lexi-Lens — choose which child is playing (or add a new one).
 *
 * v2.1 change: age_band replaced with exact age (5–12).
 *   • AgePicker shows individual ages 5–12 as chips
 *   • age_band derived server-side via DB trigger
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

const AGE_BANDS = [
  { band: "5-6",   label: "5–6 yrs",   desc: "Early reader", age: 6  },
  { band: "7-8",   label: "7–8 yrs",   desc: "Developing",   age: 8  },
  { band: "9-10",  label: "9–10 yrs",  desc: "Advancing",    age: 10 },
  { band: "11-12", label: "11–12 yrs", desc: "Proficient",   age: 12 },
] as const;
type AgeBand = typeof AGE_BANDS[number]["band"];

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
  const [name,      setName]      = useState("");
  const [ageBand,   setAgeBand]   = useState<AgeBand>("7-8");
  const [avatarKey, setAvatarKey] = useState<string>("wizard");
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError("Please enter a display name."); return; }
    setSaving(true);
    setError(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");

      const { error: insertErr } = await supabase
        .from("child_profiles")
        .insert({
          parent_id:    user.id,
          display_name: trimmed,
          age_band:     ageBand,
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

      {/* Age band */}
      <Text style={styles.addFormLabel}>Age range</Text>
      <View style={styles.chipRow}>
        {AGE_BANDS.map((b) => (
          <TouchableOpacity
            key={b.band}
            style={[styles.chip, ageBand === b.band && styles.chipActive]}
            onPress={() => { setAgeBand(b.band); Haptics.selectionAsync(); }}
          >
            <Text style={[styles.chipLabel, ageBand === b.band && styles.chipLabelActive]}>{b.label}</Text>
            <Text style={[styles.chipDesc,  ageBand === b.band && styles.chipDescActive]}>{b.desc}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Avatar */}
      <Text style={styles.addFormLabel}>Avatar</Text>
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
          style={[styles.saveBtn, saving && { opacity: 0.7 }]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving
            ? <ActivityIndicator color={P.white} size="small" />
            : <Text style={styles.saveBtnText}>Save</Text>
          }
        </TouchableOpacity>
      </View>
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
        .select("id, display_name, age_band, level, total_xp, avatar_key")
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

  addFormButtons: { flexDirection: "row", gap: 10 },
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
