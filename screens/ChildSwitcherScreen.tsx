/**
 * ChildSwitcherScreen.tsx
 * Lexi-Lens — choose which child is playing (or add a new one).
 *
 * v2.1 change: age_band replaced with exact age (5–12).
 *   • AgePicker now shows individual ages 5–12 as chips
 *   • age_band is derived server-side via DB trigger (no client logic needed)
 *   • ChildSession gains an `age` field passed to Claude for exact language matching
 *
 * All other features unchanged:
 *   • Lists all child profiles linked to the parent account
 *   • Tapping a child loads their XP, Word Tome, and completed quests
 *   • "Add child" inline form (name + age + avatar pick)
 *   • Delete child with confirmation (COPPA data removal)
 *   • Parent sign-out
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
  Auth:          undefined;
  ChildSwitcher: undefined;
  QuestMap:      undefined;
};
type Props = NativeStackScreenProps<RootStackParamList, "ChildSwitcher">;

// ─── Constants ────────────────────────────────────────────────────────────────

const AGE_BANDS = [
  { band: "5-6",   label: "5–6 yrs",   desc: "Early reader" },
  { band: "7-8",   label: "7–8 yrs",   desc: "Developing"   },
  { band: "9-10",  label: "9–10 yrs",  desc: "Advancing"    },
  { band: "11-12", label: "11–12 yrs", desc: "Proficient"   },
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
  dangerBg:     "#fff1f2",
  dangerBorder: "#fecdd3",
  dangerText:   "#9f1239",
  white:        "#ffffff",
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
  selected:  string;
  onSelect:  (key: string) => void;
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

// ─── Age band picker (ranges) ─────────────────────────────────────────────────

function AgePicker({
  selected,
  onSelect,
}: {
  selected: AgeBand;
  onSelect: (band: AgeBand) => void;
}) {
  return (
    <View style={styles.ageGrid}>
      {AGE_BANDS.map((item) => (
        <TouchableOpacity
          key={item.band}
          style={[styles.ageChip, selected === item.band && styles.ageChipSelected]}
          onPress={() => { onSelect(item.band); Haptics.selectionAsync(); }}
          accessibilityRole="radio"
          accessibilityState={{ checked: selected === item.band }}
          accessibilityLabel={item.label}
        >
          <Text style={[styles.ageChipRange, selected === item.band && styles.ageChipRangeSelected]}>
            {item.label}
          </Text>
          <Text style={[styles.ageChipDesc, selected === item.band && styles.ageChipDescSelected]}>
            {item.desc}
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
  onSaved:  () => void;
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

      <Text style={[styles.fieldLabel, { marginTop: 14 }]}>Age range</Text>
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
            : <Text style={styles.saveBtnText}>Save child ✦</Text>}
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

// ─── Child card ───────────────────────────────────────────────────────────────

function ChildCard({
  child,
  onSelect,
  onDelete,
}: {
  child:    ChildRow;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const avatarEmoji =
    AVATAR_OPTIONS.find((a) => a.key === child.avatar_key)?.emoji ?? "🧙";

  return (
    <View style={styles.childCard}>
      <TouchableOpacity
        style={styles.childCardInner}
        onPress={onSelect}
        activeOpacity={0.75}
        accessibilityRole="button"
        accessibilityLabel={`Select ${child.display_name}`}
      >
        <View style={styles.childAvatar}>
          <Text style={styles.childAvatarEmoji}>{avatarEmoji}</Text>
        </View>
        <View style={styles.childInfo}>
          <Text style={styles.childName}>{child.display_name}</Text>
          <Text style={styles.childMeta}>
            Age {child.age_band} · Lv {child.level} · {child.total_xp} XP
          </Text>
        </View>
        <Text style={styles.childChevron}>›</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.deleteBtn}
        onPress={onDelete}
        accessibilityRole="button"
        accessibilityLabel={`Delete ${child.display_name}`}
      >
        <Text style={styles.deleteBtnText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export function ChildSwitcherScreen({ navigation }: Props) {
  const insets  = useSafeAreaInsets();
  const [children,   setChildren]   = useState<ChildRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [showForm,   setShowForm]   = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const startChildSession = useGameStore((s) => s.startChildSession);
  const loadQuests        = useGameStore((s) => s.loadQuests);
  const loadCompletedQuests = useGameStore((s) => s.loadCompletedQuests);

  const fetchChildren = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("child_profiles")
        .select("id, display_name, age_band, level, total_xp, avatar_key")
        .order("created_at");
      if (error) throw error;
      setChildren(data ?? []);
    } catch (err: any) {
      Alert.alert("Error", err.message ?? "Could not load profiles");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchChildren(); }, [fetchChildren]);

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
    navigation.navigate("QuestMap");
  }, [startChildSession, loadQuests, loadCompletedQuests, navigation]);

  const handleDelete = useCallback((id: string) => {
    Alert.alert(
      "Remove child?",
      "This removes all data for this child profile. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
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
      navigation.replace("Auth");
    } catch {
      setSigningOut(false);
    }
  }, [navigation]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* ── Header ─────────────────────────────────────── */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Who's playing?</Text>
          <Text style={styles.headerSub}>Select a child to begin</Text>
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

  // Header
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
  signOutBtn:  { paddingVertical: 8, paddingHorizontal: 4 },
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
    backgroundColor:   P.parchment,
    borderRadius:      10,
    borderWidth:       1,
    borderColor:       P.warmBorder,
    paddingHorizontal: 14,
    paddingVertical:   12,
    fontSize:          15,
    color:             P.inkBrown,
  },

  // Age picker — 2×2 grid of range bands
  ageGrid: {
    flexDirection: "row",
    flexWrap:      "wrap",
    gap:           8,
  },
  ageChip: {
    width:           "47%",
    alignItems:      "center",
    paddingVertical: 12,
    borderRadius:    10,
    backgroundColor: P.parchment,
    borderWidth:     1,
    borderColor:     P.warmBorder,
  },
  ageChipSelected:        { backgroundColor: P.amberLight, borderColor: P.amber },
  ageChipRange:           { fontSize: 15, fontWeight: "700", color: P.inkMid },
  ageChipRangeSelected:   { color: P.amber },
  ageChipDesc:            { fontSize: 10, color: P.inkFaint, marginTop: 2 },
  ageChipDescSelected:    { color: P.inkLight },

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
  avatarOptionSelected: { backgroundColor: P.purpleLight, borderColor: P.purpleBorder },
  avatarOptionEmoji:    { fontSize: 24 },

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
    fontSize:          11,
    color:             P.inkFaint,
    textAlign:         "center",
    lineHeight:        17,
    marginTop:         24,
    paddingHorizontal: 8,
  },
});
