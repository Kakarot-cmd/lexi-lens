/**
 * components/Lumi/lumiGreeting.ts
 *
 * Daily-greeting state. Powers the "good morning, my magic is full again ✨"
 * line that fires the first time the app opens each calendar day.
 *
 * Public API:
 *   • shouldGreetToday()  → Promise<boolean>
 *   • markGreetedToday()  → Promise<void>
 *   • resetGreeting()     → Promise<void>   (test/debug)
 *
 * Storage key: 'lumi:lastGreetingDate' → ISO date string (YYYY-MM-DD)
 *
 * Note: this is "calendar day" using the device's local date, NOT UTC,
 * because the rate-limit reset is local-day too (see Edge Function v3.5).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'lumi:lastGreetingDate';

function todayLocalIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function shouldGreetToday(): Promise<boolean> {
  try {
    const stored = await AsyncStorage.getItem(KEY);
    return stored !== todayLocalIso();
  } catch {
    return false; // fail safe — don't spam greetings if storage flakes
  }
}

export async function markGreetedToday(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, todayLocalIso());
  } catch {
    // non-fatal
  }
}

export async function resetGreeting(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // non-fatal
  }
}
