/**
 * notifications.ts
 * Lexi-Lens — Phase 2.3 + N4
 *
 * Uses DYNAMIC imports so expo-notifications native module is never loaded
 * at app startup — only when the parent actually toggles the reminder.
 * This eliminates the "Can't find ExpoPushToken Manager" crash on Android.
 *
 * No Firebase / FCM / google-services.json required.
 * No plugin entry in app.json required.
 * Just: npx expo install expo-notifications
 *
 * NOTE: After installing expo-notifications you must run a new native build:
 *   npx expo run:android
 * (not just expo start — the native module needs to be compiled in)
 *
 * N4 addition: sendBadgeNotification() — fires an immediate local push
 * notification when a badge is earned.
 */

import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const CHANNEL_ID      = "daily-quest";
const REMINDER_ID_KEY = "lexi-daily-reminder";
const BADGE_CHANNEL_ID = "lexi-achievements";

// 2026-07 — explicit parent opt-in for badge notifications. Previously
// sendBadgeNotification() called requestNotificationPermission() itself,
// which meant the OS permission dialog could fire the first time a CHILD
// earned a badge mid-gameplay — not from any parent-facing toggle, despite
// this file's own original comment saying the intent was "only when the
// parent actually toggles the reminder." Naming mirrors the existing
// lexilens.lumi.* keys in components/Lumi/lumiSounds.ts.
const KEY_BADGE_NOTIFS_ENABLED = "lexilens.notifications.badgeEnabled";
// 2026-07 — parent-chosen reminder time. Stored as "HH:MM" (24-hour, local).
// The DAILY trigger fires at this hour/minute in the device's OWN local
// timezone, so a stored "18:00" is 6 PM wherever the user is — there is no
// global/UTC anchor and no cross-timezone midnight risk.
const KEY_REMINDER_TIME       = "lexilens.notifications.reminderTime";
const DEFAULT_REMINDER_HOUR   = 17;
const DEFAULT_REMINDER_MINUTE = 0;

/** Lazily load expo-notifications — never at module init time. */
async function getNotifications() {
  const Notifications = await import("expo-notifications");
  return Notifications;
}

// ─── Foreground behaviour ─────────────────────────────────────────────────────

/**
 * Call once in App.tsx useEffect (NOT at module level).
 * Safe — if the native module isn't ready it silently does nothing.
 */
export async function setForegroundNotificationBehavior(): Promise<void> {
  try {
    const N = await getNotifications();
    N.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert:  true,
        shouldShowBanner: true,
        shouldShowList:   true,
        shouldPlaySound:  true,
        shouldSetBadge:   false,
      }),
    });
  } catch {
    // Native module not available — skip silently
  }
}

// ─── Permission ───────────────────────────────────────────────────────────────

export async function requestNotificationPermission(): Promise<boolean> {
  try {
    const N = await getNotifications();
    const { status, canAskAgain } = await N.getPermissionsAsync();
    if (status === "granted") return true;
    if (!canAskAgain) return false;
    const { status: next } = await N.requestPermissionsAsync();
    return next === "granted";
  } catch {
    return false;
  }
}

// ─── Android channel ──────────────────────────────────────────────────────────

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    const N = await getNotifications();
    await N.setNotificationChannelAsync(CHANNEL_ID, {
      name:             "Daily Quest Reminders",
      importance:       N.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor:       "#7c3aed",
    });
  } catch {
    // Fallback to default channel — notification will still fire
  }
}

// ─── Schedule daily reminder ──────────────────────────────────────────────────

export async function scheduleDailyQuestReminder(
  hour      = 18,
  minute    = 0,
  childName = ""
): Promise<void> {
  try {
    const granted = await requestNotificationPermission();
    if (!granted) return;

    await ensureChannel();
    await cancelDailyReminder();

    const N = await getNotifications();

    await N.scheduleNotificationAsync({
      identifier: REMINDER_ID_KEY,
      content: {
        title: "✦ Daily Quest awaits!",
        body:  childName
          ? `${childName}'s streak is waiting — defeat today's enemy!`
          : "Keep your streak alive — a new dungeon foe needs defeating!",
        sound: true,
        data:  { screen: "QuestMap" },
      },
      trigger: {
        type:      N.SchedulableTriggerInputTypes.DAILY,
        hour,
        minute,
        channelId: CHANNEL_ID,
      },
    });
  } catch (e) {
    console.warn("[notifications] schedule failed:", e);
  }
}

// ─── Cancel daily reminder ────────────────────────────────────────────────────

export async function cancelDailyReminder(): Promise<void> {
  try {
    const N = await getNotifications();
    await N.cancelScheduledNotificationAsync(REMINDER_ID_KEY);
  } catch {
    // Never scheduled — ignore
  }
}

// ─── Reminder-time preference ─────────────────────────────────────────────────

export interface ReminderTime { hour: number; minute: number; }

/**
 * Parent-chosen daily-reminder time (local). Falls back to 18:00 (the prior
 * hardcoded default) when nothing is stored or the stored value is malformed,
 * so existing installs keep their current 6 PM behaviour until the parent
 * changes it. Pure AsyncStorage read — never touches the native notifications
 * module, so it's cheap to call on mount.
 */
export async function getReminderTime(): Promise<ReminderTime> {
  try {
    const stored = await AsyncStorage.getItem(KEY_REMINDER_TIME);
    if (stored) {
      const [h, m] = stored.split(":").map((n) => parseInt(n, 10));
      if (Number.isInteger(h) && Number.isInteger(m) &&
          h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        return { hour: h, minute: m };
      }
    }
  } catch { /* fall through to default */ }
  return { hour: DEFAULT_REMINDER_HOUR, minute: DEFAULT_REMINDER_MINUTE };
}

/**
 * Persists the chosen reminder time. Does NOT (re)schedule — the caller decides
 * whether to reschedule (only meaningful while the reminder is enabled). Values
 * are clamped to valid ranges defensively.
 */
export async function setReminderTime(hour: number, minute: number): Promise<void> {
  const h = Math.min(23, Math.max(0, Math.floor(hour)));
  const m = Math.min(59, Math.max(0, Math.floor(minute)));
  try {
    await AsyncStorage.setItem(KEY_REMINDER_TIME, `${h}:${m}`);
  } catch { /* non-fatal */ }
}

// ─── Tap handler ──────────────────────────────────────────────────────────────

export async function registerNotificationTapHandler(
  navigate: (screen: string) => void
): Promise<() => void> {
  try {
    const N = await getNotifications();
    const sub = N.addNotificationResponseReceivedListener((response) => {
      const screen = response.notification.request.content.data?.screen;
      if (typeof screen === "string") navigate(screen);
    });
    return () => sub.remove();
  } catch {
    return () => {};
  }
}

// ─── N4: Badge earned notification ───────────────────────────────────────────

/**
 * Fire an immediate local push notification when a badge is earned.
 * Uses trigger: null → fires instantly (expo-notifications 0.28+).
 *
 * Safe to call even if the user hasn't granted notification permission
 * (requestNotificationPermission returns false silently).
 *
 * @param badge — Badge object from achievementService.ts
 */
/**
 * Reads the stored preference. If the parent has never explicitly toggled
 * it, falls back to the current OS permission grant — this is the
 * non-disruptive path for anyone upgrading from the old always-request
 * behaviour: if they'd already granted permission under the old flow,
 * badges keep working with no re-opt-in; if they hadn't, badges simply
 * stay silent until a parent turns this on in ParentDashboard.
 */
export async function getBadgeNotificationsEnabled(): Promise<boolean> {
  try {
    const stored = await AsyncStorage.getItem(KEY_BADGE_NOTIFS_ENABLED);
    if (stored !== null) return JSON.parse(stored);
    const N = await getNotifications();
    const { status } = await N.getPermissionsAsync();
    return status === "granted";
  } catch {
    return false;
  }
}

/**
 * Parent-initiated toggle (ParentDashboard only). Turning ON asks the OS
 * permission dialog here, explicitly, from a gated parent-facing screen —
 * turning OFF just persists the preference, no need to touch OS state.
 * Returns the actual resulting state so the UI can snap back if the OS
 * permission was denied.
 */
export async function setBadgeNotificationsEnabled(on: boolean): Promise<boolean> {
  const actual = on ? await requestNotificationPermission() : false;
  try {
    await AsyncStorage.setItem(KEY_BADGE_NOTIFS_ENABLED, JSON.stringify(actual));
  } catch { /* non-fatal */ }
  return actual;
}

export async function sendBadgeNotification(badge: {
  emoji:       string;
  name:        string;
  description: string;
  rarity:      string;
}): Promise<void> {
  try {
    // 2026-07 — check-only. No permission request here anymore; that only
    // ever happens from setBadgeNotificationsEnabled() above, behind the
    // ParentDashboard PIN gate. If the parent hasn't opted in, badges are
    // earned and stored as normal — this function just stays silent.
    const enabled = await getBadgeNotificationsEnabled();
    if (!enabled) return;

    const N = await getNotifications();

    // Create the achievement channel (Android) — idempotent
    if (Platform.OS === "android") {
      await N.setNotificationChannelAsync(BADGE_CHANNEL_ID, {
        name:             "Achievement Badges",
        importance:       N.AndroidImportance.HIGH,
        vibrationPattern: [0, 100, 80, 100],
        lightColor:       "#f59e0b",
      });
    }

    const isHighRarity = badge.rarity === "legendary" || badge.rarity === "epic";

    await N.scheduleNotificationAsync({
      identifier: `badge-${badge.name.replace(/\s+/g, "-").toLowerCase()}-${Date.now()}`,
      content: {
        title: isHighRarity
          ? `${badge.emoji} ${badge.name} — ${badge.rarity.toUpperCase()} badge unlocked!`
          : `${badge.emoji} Badge unlocked: ${badge.name}`,
        body:  badge.description,
        sound: true,
        data:  { screen: "ParentDashboard", type: "badge" },
        ...(Platform.OS === "android" && { channelId: BADGE_CHANNEL_ID }),
      },
      trigger: null,   // fire immediately
    });
  } catch (e) {
    console.warn("[notifications] sendBadgeNotification failed:", e);
  }
}
