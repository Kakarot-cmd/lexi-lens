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

const CHANNEL_ID      = "daily-quest";
const REMINDER_ID_KEY = "lexi-daily-reminder";
const BADGE_CHANNEL_ID = "lexi-achievements";

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
        title: "⚔ Daily Quest awaits!",
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
export async function sendBadgeNotification(badge: {
  emoji:       string;
  name:        string;
  description: string;
  rarity:      string;
}): Promise<void> {
  try {
    const granted = await requestNotificationPermission();
    if (!granted) return;

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
