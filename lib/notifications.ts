/**
 * notifications.ts
 * Lexi-Lens — Phase 2.3
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
 */

import { Platform } from "react-native";

const CHANNEL_ID      = "daily-quest";
const REMINDER_ID_KEY = "lexi-daily-reminder";

/** Lazily load expo-notifications — never at module init time. */
async function getNotifications() {
  // Dynamic import — only loads native module when this function is called
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
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge:  false,
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

// ─── Schedule ─────────────────────────────────────────────────────────────────

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

// ─── Cancel ───────────────────────────────────────────────────────────────────

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
