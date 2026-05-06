/**
 * lib/supabase.ts
 * Lexi-Lens — Supabase client singleton.
 *
 * Updated for the dev/staging/prod environment split (v4.5):
 * URL and anon key now come from `lib/env.ts` instead of reading
 * `process.env.EXPO_PUBLIC_*` directly. Behaviour is identical when
 * APP_VARIANT is unset (falls back to a single .env file).
 */

import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

import { ENV } from './env';

export const supabase = createClient(ENV.supabase.url, ENV.supabase.anonKey, {
  auth: {
    storage:            AsyncStorage,
    autoRefreshToken:   true,
    persistSession:     true,
    detectSessionInUrl: false,
  },
});

// ─── Convenience wrappers (unchanged from previous version) ──────────────────

export async function getUser() {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error) throw error;
  return user;
}

export async function signInWithEmail(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export function onAuthStateChange(
  callback: (event: string, session: any) => void,
) {
  return supabase.auth.onAuthStateChange(callback);
}
