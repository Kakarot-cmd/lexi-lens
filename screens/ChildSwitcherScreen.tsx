/**
 * ChildSwitcherScreen.tsx
 * Lexi-Lens — choose which child is playing (or add a new one).
 *
 * Shown after parent login, and reachable from QuestMapScreen
 * via the character card's "switch child" button.
 *
 * Features:
 *   • Lists all child profiles linked to the parent account
 *   • Tapping a child loads their XP, Word Tome, and completed quests
 *     into the store then navigates to QuestMapScreen
 *   • "Add child" inline form (name + age band + avatar pick)
 *   • Delete child (swipe-to-reveal, with confirmation — COPPA data removal)
 *   • Parent sign-out button in the header
 *
 * Aesthetic: warm parchment — parent's world, not the dungeon.
 *
 * Dependencies (all installed):
 *   @supabase/supabase-js
 *   react-native-safe-area-context
 *   expo-haptics
 *   zustand
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
import { useSafeAreaInsets }    from "react-native-safe-area-context";
import * as Haptics             from "expo-haptics";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import { supabase, signOut }    from "../lib/supabase";
import { useGameStore }         from "../store/gameStore";

// ─── Navigation types ─────────────────────────────────────────────────────────

type RootStackParamList = {
  Auth:         undefined;
  ChildSwitcher: undefined;
  QuestMap:     undefined;
};
type Props = NativeStackScreenProps<RootStackParamList, "ChildSwitcher">;

// ─── Constants ────────────────────────────────────────────────────────────────

const AGE_BANDS = ["5-6", "7-8", "9-10", "11-12"] as const;
type AgeBand = typeof AGE_BANDS[number];

const AVATAR_OPTIONS = [
  { key: "wizard",  emoji: "🧙", label: "Wizard" },
  { key: "knight",  emoji: "⚔️", label: "Knight" },
  { key: "archer",  emoji: "🏹", label: "Archer" },
  { key: "dragon",  emoji: "🐉", label: "Dragon" },
] as const;

const P = {
  cream:       "#fdf8f0",
  parchment:   "#f5edda",
  warmBorder:  "#e2d0b0",
  inkBrown:    "#3d2a0f",
  inkMid:      "#6b4c1e",
  inkLight:    "#9c7540",
  inkFaint:    "#c4a97a",
  amber:       "#d97706",
  amberLight:  "#fef3c7",
  amberBorder: "#fde68a",
  purple:      "#7c3aed",
  purpleLight: "#f5f3ff",
  purpleBorder:"#ddd6fe",
  dangerBg:    "#fff1f2",
  dangerBorder:"#fecdd3",
  dangerText:  "#9f1239",
  white:       "#ffffff",
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

// ─── Avatar picker ────────────────────────────────────────────────────────────

function AvatarPicker({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (key: string) => void;
}) {
  return (
    <View style={styles.avatarRow}>
      {AVATAR_OPTIONS.map((a) => (
        <TouchableOpacity
          key={a.key}
          style={[styles.avatarOption, selected === a.key && styles.avatarOptionSelected]}
          onPress={() => { onSelect(a.key); Haptics.selectionAsync(); }}
          accessibilityRole="radio"
          accessibilityState={{ checked: selected === a.key }}
          accessibilityLabel={a.label}
        >
          <Text style={styles.avatarOptionEmoji}>{a.emoji}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ─── Age band picker ──────────────────────────────────────────────────────────

function AgePicker({
  selected,
  onSelect,
}: {
  selected: AgeBand;
  onSelect: (band: AgeBand) => void;
}) {
  return (
    <View style={styles.ageRow}>
      {AGE_BANDS.map((band) => (
        <TouchableOpacity
          key={band}
          style={[styles.ageChip, selected === band && styles.ageChipSelected]}
          onPress={() => { onSelect(band); Haptics.selectionAsync(); }}
          accessibilityRole="radio"
          accessibilityState={{ checked: selected === band }}
          accessibilityLabel={`Age ${band}`}
        >
          <Text style={[styles.ageChipText, selected === band && styles.ageChipTextSelected]}>
            {band}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ─── Add child form ───────────────────────────────────────────────────────────

function AddChildForm({
  onSaved,
  onCancel,
}: {
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name,      setName]      = useState("");
  const [ageBand,   setAgeBand]   = useState<AgeBand>("7-8");
  const [avatarKey, setAvatarKey] = useState("wizard");
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  const slideAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: 1, useNativeDriver: true, tension: 70, friction: 10,
    }).start();
  }, []);

  const handleSave = async () => {
    if (!name.trim()) { setError("Enter a name for this child"); return; }
    setLoading(true);
    setError(null);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");

      const { error: insertErr } = await supabase.from("child_profiles").insert({
        parent_id:    user.id,
        display_name: name.trim(),
        age_band:     ageBand,
        avatar_key:   avatarKey,
      });
      if (insertErr) throw insertErr;

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSaved();
    } catch (err: any) {
      setError(err.message ?? "Could not save child profile");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Animated.View
      style={[
        styles.addForm,
        {
          opacity:   slideAnim,
          transform: [{ translateY: slideAnim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
        },
      ]}
    >
      <Text style={styles.addFormTitle}>Add a child</Text>

      {error && (
        <View style={styles.formErrorBox}>
          <Text style={styles.formErrorText}>{error}</Text>
        </View>
      )}

      <Text style={styles.fieldLabel}>Name</Text>
      <TextInput
        style={styles.textInput}
        placeholder="e.g. Rohan"
        placeholderTextColor={P.inkFaint}
        value={name}
        onChangeText={(v) => { setName(v); setError(null); }}
        autoCapitalize="words"
        autoFocus
        returnKeyType="done"
        accessibilityLabel="Child's name"
      />

      <Text style={[styles.fieldLabel, { marginTop: 14 }]}>Age</Text>
      <AgePicker selected={ageBand} onSelect={setAgeBand} />

      <Text style={[styles.fieldLabel, { marginTop: 14 }]}>Avatar</Text>
      <AvatarPicker selected={avatarKey} onSelect={setAvatarKey} />

      <View style={styles.addFormButtons}>
        <TouchableOpacity
          style={styles.cancelBtn}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel adding child"
        >
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.saveBtn, loading && { opacity: 0.65 }]}
          onPress={handleSave}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel="Save child profile"
        >
          {loading
            ? <ActivityIndicator color={P.white} />
            : <Text style={styles.saveBtnText}>Save child</Text>}
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

// ─── Child card ───────────────────────────────────────────────────────────────

const AVATAR_EMOJIS: Record<string, string> = {
  wizard: "🧙", knight: "⚔️", archer: "🏹", dragon: "🐉", default: "✦",
};

function ChildCard({
  child,
  onSelect,
  onDelete,
}: {
  child:    ChildRow;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const emoji    = AVATAR_EMOJIS[child.avatar_key ?? "default"] ?? "✦";
  const scaleRef = useRef(new Animated.Value(1)).current;

  const handlePress = () => {
    Animated.sequence([
      Animated.timing(scaleRef, { toValue: 0.96, duration: 70,  useNativeDriver: true }),
      Animated.timing(scaleRef, { toValue: 1,    duration: 100, useNativeDriver: true }),
    ]).start();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onSelect();
  };

  const handleDelete = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert(
      `Remove ${child.display_name}?`,
      "This will permanently delete their progress, Word Tome, and quest history. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: onDelete },
      ]
    );
  };

  return (
    <Animated.View style={[styles.childCard, { transform: [{ scale: scaleRef }] }]}>
      <TouchableOpacity
        style={styles.childCardInner}
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={`Play as ${child.display_name}, level ${child.level}`}
      >
        <View style={styles.childAvatar}>
          <Text style={styles.childAvatarEmoji}>{emoji}</Text>
        </View>
        <View style={styles.childInfo}>
          <Text style={styles.childName}>{child.display_name}</Text>
          <Text style={styles.childMeta}>
            Level {child.level} · Age {child.age_band} · {child.total_xp.toLocaleString()} XP
          </Text>
        </View>
        <Text style={styles.childChevron}>›</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.deleteBtn}
        onPress={handleDelete}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${child.display_name}`}
      >
        <Text style={styles.deleteBtnText}>✕</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export function ChildSwitcherScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();

  const [children,   setChildren]   = useState<ChildRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [showForm,   setShowForm]   = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const startChildSession  = useGameStore((s) => s.startChildSession);
  const setWordTomeCache   = useGameStore((s) => s.setWordTomeCache);
  const endChildSession    = useGameStore((s) => s.endChildSession);

  // ── Fetch children ─────────────────────────────────────────
  const fetchChildren = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("child_profiles")
      .select("id, display_name, age_band, level, total_xp, avatar_key")
      .order("created_at");
    setChildren(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchChildren();
    endChildSession(); // clear any previous session
  }, []);

  // ── Select child → load Word Tome → navigate ───────────────
  const handleSelect = async (child: ChildRow) => {
    startChildSession({
      id:           child.id,
      display_name: child.display_name,
      age_band:     child.age_band,
      level:        child.level,
      total_xp:     child.total_xp,
      avatar_key:   child.avatar_key,
    });

    // Pre-warm the Word Tome cache
    const { data } = await supabase
      .from("word_tome")
      .select("word, definition, exemplar_object, times_used, first_used_at")
      .eq("child_id", child.id)
      .order("first_used_at", { ascending: false });

    if (data) setWordTomeCache(data);
    navigation.replace("QuestMap");
  };

  // ── Delete child ───────────────────────────────────────────
  const handleDelete = async (childId: string) => {
    // Cascade deletes word_tome, scan_attempts, quest_completions via FK
    await supabase.from("child_profiles").delete().eq("id", childId);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    fetchChildren();
  };

  // ── Sign out ───────────────────────────────────────────────
  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
      // onAuthStateChange in App.tsx handles navigation to AuthScreen
    } catch {
      setSigningOut(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────
  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Who's playing?</Text>
          <Text style={styles.headerSub}>Choose a child to start their quest</Text>
        </View>
        <TouchableOpacity
          style={styles.signOutBtn}
          onPress={handleSignOut}
          disabled={signingOut}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
        >
          {signingOut
            ? <ActivityIndicator color={P.inkLight} size="small" />
            : <Text style={styles.signOutText}>Sign out</Text>}
        </TouchableOpacity>
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
            {/* Child list */}
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

            {/* Add child form */}
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

            {/* COPPA note */}
            {!showForm && (
              <Text style={styles.coppaNote}>
                🔒 Child profiles use a display name and age band only — no email address or
                date of birth is stored for children, in accordance with COPPA.
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

  // Header
  header: {
    flexDirection:    "row",
    alignItems:       "center",
    justifyContent:   "space-between",
    paddingHorizontal: 20,
    paddingBottom:    12,
    borderBottomWidth: 1,
    borderBottomColor: P.warmBorder,
  },
  headerTitle: { fontSize: 22, fontWeight: "800", color: P.inkBrown, letterSpacing: -0.3 },
  headerSub:   { fontSize: 13, color: P.inkLight, marginTop: 2 },
  signOutBtn:  { paddingVertical: 8, paddingHorizontal: 4 },
  signOutText: { fontSize: 14, color: P.inkLight, fontWeight: "500" },

  // Child card
  childCard: {
    flexDirection:    "row",
    alignItems:       "center",
    backgroundColor:  P.white,
    borderRadius:     16,
    borderWidth:      1,
    borderColor:      P.warmBorder,
    marginTop:        12,
    overflow:         "hidden",
    ...Platform.select({
      ios:     { shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 6 },
      android: { elevation: 2 },
    }),
  },
  childCardInner: {
    flex:          1,
    flexDirection: "row",
    alignItems:    "center",
    padding:       16,
    gap:           14,
  },
  childAvatar: {
    width:           50,
    height:          50,
    borderRadius:    25,
    backgroundColor: P.amberLight,
    borderWidth:     1,
    borderColor:     P.amberBorder,
    alignItems:      "center",
    justifyContent:  "center",
  },
  childAvatarEmoji: { fontSize: 26 },
  childInfo:        { flex: 1 },
  childName:        { fontSize: 17, fontWeight: "700", color: P.inkBrown },
  childMeta:        { fontSize: 12, color: P.inkLight, marginTop: 3 },
  childChevron:     { fontSize: 22, color: P.inkFaint },
  deleteBtn: {
    paddingHorizontal: 14,
    paddingVertical:   16,
    backgroundColor:   P.dangerBg,
    borderLeftWidth:   1,
    borderLeftColor:   P.dangerBorder,
  },
  deleteBtnText: { fontSize: 14, color: P.dangerText, fontWeight: "700" },

  // Add child button
  addChildBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             8,
    marginTop:       12,
    paddingVertical: 16,
    borderRadius:    16,
    borderWidth:     1.5,
    borderColor:     P.amberBorder,
    borderStyle:     "dashed",
    backgroundColor: P.amberLight,
  },
  addChildBtnPlus: { fontSize: 20, color: P.amber, fontWeight: "700", lineHeight: 22 },
  addChildBtnText: { fontSize: 15, fontWeight: "600", color: P.amber },

  // Add child form
  addForm: {
    backgroundColor: P.white,
    borderRadius:    16,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    padding:         20,
    marginTop:       12,
  },
  addFormTitle: { fontSize: 17, fontWeight: "700", color: P.inkBrown, marginBottom: 16 },
  formErrorBox: {
    backgroundColor: P.dangerBg,
    borderRadius:    8,
    borderWidth:     1,
    borderColor:     P.dangerBorder,
    padding:         10,
    marginBottom:    14,
  },
  formErrorText: { fontSize: 13, color: P.dangerText },
  fieldLabel:    { fontSize: 13, fontWeight: "600", color: P.inkMid, marginBottom: 8 },
  textInput: {
    backgroundColor:  P.parchment,
    borderRadius:     10,
    borderWidth:      1,
    borderColor:      P.warmBorder,
    paddingHorizontal: 14,
    paddingVertical:  12,
    fontSize:         15,
    color:            P.inkBrown,
  },

  // Age picker
  ageRow: { flexDirection: "row", gap: 8 },
  ageChip: {
    flex:             1,
    alignItems:       "center",
    paddingVertical:  10,
    borderRadius:     10,
    backgroundColor:  P.parchment,
    borderWidth:      1,
    borderColor:      P.warmBorder,
  },
  ageChipSelected:     { backgroundColor: P.amberLight, borderColor: P.amberBorder },
  ageChipText:         { fontSize: 13, fontWeight: "500", color: P.inkMid },
  ageChipTextSelected: { color: P.amber, fontWeight: "700" },

  // Avatar picker
  avatarRow:           { flexDirection: "row", gap: 10 },
  avatarOption: {
    flex:            1,
    alignItems:      "center",
    paddingVertical: 10,
    borderRadius:    12,
    backgroundColor: P.parchment,
    borderWidth:     1,
    borderColor:     P.warmBorder,
  },
  avatarOptionSelected:  { backgroundColor: P.purpleLight, borderColor: P.purpleBorder },
  avatarOptionEmoji:     { fontSize: 24 },

  // Form buttons
  addFormButtons: { flexDirection: "row", gap: 10, marginTop: 20 },
  cancelBtn: {
    flex:            1,
    alignItems:      "center",
    paddingVertical: 13,
    borderRadius:    12,
    borderWidth:     1,
    borderColor:     P.warmBorder,
  },
  cancelBtnText: { fontSize: 14, fontWeight: "600", color: P.inkMid },
  saveBtn: {
    flex:            1,
    alignItems:      "center",
    paddingVertical: 13,
    borderRadius:    12,
    backgroundColor: P.amber,
  },
  saveBtnText: { fontSize: 14, fontWeight: "700", color: P.white },

  // Empty state
  emptyState: { alignItems: "center", paddingVertical: 40, gap: 10 },
  emptyEmoji: { fontSize: 52 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: P.inkBrown },
  emptyDesc:  { fontSize: 14, color: P.inkLight, textAlign: "center", lineHeight: 20 },

  // COPPA note
  coppaNote: {
    fontSize:   11,
    color:      P.inkFaint,
    textAlign:  "center",
    lineHeight: 17,
    marginTop:  24,
    paddingHorizontal: 8,
  },
});
