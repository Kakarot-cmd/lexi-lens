/**
 * ChildSwitcherScreen.tsx
 * Lexi-Lens — choose which child is playing (or add a new one).
 *
 * v2.1 change: age_band replaced with exact age (5–12).
 *   • AgePicker now shows individual ages 5–12 as chips
 *   • age_band is derived server-side via DB trigger (no client logic needed)
 *
 * N1 change: handleSelect now checks hasSeenOnboarding and routes to the
 * onboarding walkthrough on first launch instead of jumping straight to QuestMap.
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

type RootStackParamList = {
  Auth:            undefined;
  ChildSwitcher:   undefined;
  QuestMap:        undefined;
  ParentDashboard: undefined;
  Onboarding:      undefined;   // ← N1
};
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
    <View style={styles.ageGrid}>
      {AGE_BANDS.map((item) => {
        const isSelected = selected === item.band;
        return (
          <TouchableOpacity
            key={item.band}
            style={[styles.ageChip, isSelected && styles.ageChipSelected]}
            onPress={() => { onSelect(item.band); Haptics.selectionAsync(); }}
            accessibilityRole="radio"
            accessibilityState={{ checked: isSelected }}
            accessibilityLabel={item.label}
          >
            <Text style={[styles.ageChipRange, isSelected && styles.ageChipRangeSelected]}>
              {item.label}
            </Text>
            <Text style={[styles.ageChipDesc, isSelected && styles.ageChipDescSelected]}>
              {item.desc}
            </Text>
          </TouchableOpacity>
        );
      })}
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

      const scheduledAt = user.app_metadata?.deletion_scheduled_at;
      if (scheduledAt) {
        const daysLeft = Math.ceil(
          (new Date(scheduledAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        );
        setError(
          `Your account is scheduled for deletion in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}. ` +
          `New child profiles cannot be added. Contact privacy@lexi-lens.app to cancel the deletion.`
        );
        return;
      }

      const selectedBand = AGE_BANDS.find((b) => b.band === ageBand)!;
      const { error: insertErr } = await supabase.from("child_profiles").insert({
        parent_id:    user.id,
        display_name: name.trim(),
        age_band:     ageBand,
        age:          selectedBand.age,
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
            {child.age_band ? `Age ${child.age_band}` : "Age —"} · Lv {child.level} · {child.total_xp} XP
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
  const insets = useSafeAreaInsets();
  const [children,   setChildren]   = useState<ChildRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [showForm,   setShowForm]   = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const [pinVisible,  setPinVisible]  = useState(false);
  const [parentId,    setParentId]    = useState("");
  const [parentEmail, setParentEmail] = useState("");

  const startChildSession   = useGameStore((s) => s.startChildSession);
  const loadQuests          = useGameStore((s) => s.loadQuests);
  const loadCompletedQuests = useGameStore((s) => s.loadCompletedQuests);

  // ── N1: onboarding gate ───────────────────────────────────────────────────
  const hasSeenOnboarding = useGameStore((s) => s.hasSeenOnboarding);

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

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        setParentId(user.id);
        setParentEmail(user.email ?? "");
      }
    });
  }, []);

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

    // ── N1: route to onboarding on first launch, QuestMap thereafter ────────
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
      {/* ── Header ──────────────────────────────────────────────── */}
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
              : <Text style={styles.signOutText}>Sign out</Text>}
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
  signOutBtn:  { paddingVertical: 8, paddingHorizontal: 4 },
  signOutText: { fontSize: 14, color: P.inkLight, fontWeight: "500" },

  headerActions: {
    flexDirection: "row",
    alignItems:    "center",
  },
  dashboardBtn: {
    backgroundColor:   P.purpleLight,
    borderRadius:      20,
    paddingHorizontal: 10,
    paddingVertical:   7,
    borderWidth:       1,
    borderColor:       P.purpleBorder,
    marginRight:       8,
  },
  dashboardBtnText: {
    color:      P.purple,
    fontSize:   12,
    fontWeight: "700",
  },

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
    marginRight:     14,
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

  addChildBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    marginTop:       12,
    paddingVertical: 16,
    borderRadius:    16,
    borderWidth:     1.5,
    borderColor:     P.amberBorder,
    borderStyle:     "dashed",
    backgroundColor: P.amberLight,
  },
  addChildBtnPlus: { fontSize: 20, color: P.amber, fontWeight: "700", lineHeight: 22, marginRight: 8 },
  addChildBtnText: { fontSize: 15, fontWeight: "600", color: P.amber },

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

  ageGrid: {
    flexDirection: "row",
    flexWrap:      "wrap",
  },
  ageChip: {
    width:           "47%",
    alignItems:      "center",
    paddingVertical: 12,
    borderRadius:    10,
    backgroundColor: P.parchment,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    marginRight:     "3%",
    marginBottom:    8,
  },
  ageChipSelected:      { backgroundColor: P.amberLight, borderColor: P.amber },
  ageChipRange:         { fontSize: 15, fontWeight: "700", color: P.inkMid },
  ageChipRangeSelected: { color: P.amber },
  ageChipDesc:          { fontSize: 10, color: P.inkFaint, marginTop: 2 },
  ageChipDescSelected:  { color: P.inkLight },

  avatarRow:           { flexDirection: "row" },
  avatarOption: {
    flex:            1,
    alignItems:      "center",
    paddingVertical: 10,
    borderRadius:    12,
    backgroundColor: P.parchment,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    marginRight:     8,
  },
  avatarOptionSelected: { backgroundColor: P.purpleLight, borderColor: P.purpleBorder },
  avatarOptionEmoji:    { fontSize: 24 },

  addFormButtons: { flexDirection: "row", marginTop: 20 },
  cancelBtn: {
    flex:            1,
    alignItems:      "center",
    paddingVertical: 13,
    borderRadius:    12,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    marginRight:     10,
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

  emptyState: { alignItems: "center", paddingVertical: 40 },
  emptyEmoji: { fontSize: 52, marginBottom: 10 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: P.inkBrown, marginBottom: 8 },
  emptyDesc:  { fontSize: 14, color: P.inkLight, textAlign: "center", lineHeight: 20 },

  coppaNote: {
    fontSize:          11,
    color:             P.inkFaint,
    textAlign:         "center",
    lineHeight:        17,
    marginTop:         24,
    paddingHorizontal: 8,
  },
});
