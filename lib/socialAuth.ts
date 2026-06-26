/**
 * lib/socialAuth.ts
 * Skanlore — native social sign-in (Google + Apple) → Supabase.
 *
 * WHY NATIVE (signInWithIdToken) AND NOT THE BROWSER OAUTH FLOW
 * ────────────────────────────────────────────────────────────
 * Supabase's `signInWithOAuth` opens a system browser, bounces through a
 * redirect URL, and relies on the app's deep-link scheme to catch the
 * callback. That is exactly the fragile path we already fight with for
 * email-confirm / password-reset links (see App.tsx deep-link handler), and
 * it gives a clunky out-of-app experience. The native ID-token flow keeps the
 * whole thing in-app:
 *
 *   1. The platform SDK (Google / Apple) shows its NATIVE account picker.
 *   2. It hands us a signed OIDC **ID token**.
 *   3. We pass that token to `supabase.auth.signInWithIdToken(...)`, which
 *      verifies the signature + audience against the provider's public keys
 *      server-side and mints a Supabase session.
 *
 * No browser, no redirect URL, no extra deep-link surface area.
 *
 * COPPA NOTE
 * ──────────
 * This module ONLY establishes the authenticated parent session. It does NOT
 * grant entry to the app. A *new* social user has a session but no consent
 * metadata, so App.tsx raises the consent gate (lib/authFlow.consentPending)
 * and AuthScreen forces the existing ConsentGateModal (incl. the parental
 * math gate) before anything child-facing renders. See AuthScreen.performOAuthConsent.
 *
 * NONCE HANDLING (the classic footgun — verified against Supabase + provider docs)
 * ───────────────────────────────────────────────────────────────────────────────
 *   • Apple: we generate a rawNonce, give Apple SHA256(rawNonce), and give
 *     Supabase the rawNonce. Apple embeds the value we passed verbatim into the
 *     token's `nonce` claim; Supabase hashes the rawNonce we passed and compares.
 *     → hashed → Apple, raw → Supabase.
 *   • Google: the @react-native-google-signin iOS SDK does not reliably embed a
 *     nonce, so per Supabase's own guidance we DON'T pass one here and instead
 *     enable "Skip Nonce Check" on the Google provider (see SOCIAL_AUTH_SETUP.md).
 *     Security is unaffected — Supabase still verifies the token signature and
 *     audience (our Web client ID) against Google's keys.
 */

import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import {
  GoogleSignin,
  isSuccessResponse,
  isErrorWithCode,
  statusCodes,
} from '@react-native-google-signin/google-signin';

import { supabase } from './supabase';
import { ENV } from './env';
import { getAuthFlow } from './authFlow';

// ─── Result shape ─────────────────────────────────────────────────────────────

export type SocialResult =
  | { ok: true }
  | { ok: false; cancelled?: boolean; message?: string };

// ─── Google ───────────────────────────────────────────────────────────────────

let googleConfigured = false;

/**
 * Idempotent. Safe to call at app start (warms the SDK) and again lazily before
 * the first sign-in. No-ops with a dev warning if the Web client ID is unset, so
 * a build without OAuth env vars simply hides the Google button rather than crash.
 */
export function configureGoogleSignin(): void {
  if (googleConfigured) return;
  const webClientId = ENV.oauth.googleWebClientId;
  if (!webClientId) {
    if (__DEV__) {
      console.warn(
        '[socialAuth] EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is unset — Google sign-in disabled.',
      );
    }
    return;
  }
  GoogleSignin.configure({
    webClientId,
    // iosClientId is only consulted on iOS; harmless elsewhere. Without it the
    // iOS SDK falls back to the URL scheme from the config plugin, but passing
    // it explicitly is the documented happy path.
    iosClientId: ENV.oauth.googleIosClientId || undefined,
    scopes: ['email', 'profile'],
    offlineAccess: false,
  });
  googleConfigured = true;
}

/** True when the build has a Web client ID — drives whether the button renders. */
export function isGoogleEnabled(): boolean {
  return !!ENV.oauth.googleWebClientId;
}

export async function signInWithGoogle(): Promise<SocialResult> {
  try {
    configureGoogleSignin();
    if (!googleConfigured) {
      return { ok: false, message: 'Google sign-in is not configured for this build.' };
    }

    // Android needs Play Services; iOS ignores this call.
    if (Platform.OS === 'android') {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    }

    const response = await GoogleSignin.signIn();

    // @react-native-google-signin v13+ returns a discriminated union:
    //   { type: 'success', data: {...} } | { type: 'cancelled' | 'noSavedCredentialFound' }
    if (!isSuccessResponse(response)) {
      return { ok: false, cancelled: true };
    }

    const idToken = response.data?.idToken ?? null;
    if (!idToken) {
      return {
        ok: false,
        message:
          'Google did not return an ID token. Verify the Web client ID and that the ' +
          'OAuth client matches this app\u2019s package / SHA-1 (see SOCIAL_AUTH_SETUP.md).',
      };
    }

    const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken });
    if (error) return { ok: false, message: error.message };

    // Stash provider display name so the consent step can stamp it (new users only).
    const u = response.data?.user;
    const name = u?.name ?? [u?.givenName, u?.familyName].filter(Boolean).join(' ').trim();
    if (name) getAuthFlow().setPendingDisplayName(name);

    return { ok: true };
  } catch (e: any) {
    if (isErrorWithCode(e)) {
      if (e.code === statusCodes.SIGN_IN_CANCELLED) return { ok: false, cancelled: true };
      if (e.code === statusCodes.IN_PROGRESS)        return { ok: false, cancelled: true };
      if (e.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
        return { ok: false, message: 'Google Play Services is unavailable or out of date on this device.' };
      }
    }
    return { ok: false, message: e?.message ?? 'Google sign-in failed.' };
  }
}

// ─── Apple ──────────────────────────────────────────────────────────────────

/** iOS 13+ only. Drives whether the Apple button renders (also required by 4.8). */
export async function isAppleAuthAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

export async function signInWithApple(): Promise<SocialResult> {
  try {
    if (Platform.OS !== 'ios') {
      return { ok: false, message: 'Apple sign-in is only available on iOS.' };
    }

    const rawNonce = Crypto.randomUUID();
    const hashedNonce = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      rawNonce,
    );

    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce, // hashed → Apple
    });

    if (!credential.identityToken) {
      return { ok: false, message: 'Apple did not return an identity token.' };
    }

    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: credential.identityToken,
      nonce: rawNonce, // raw → Supabase
    });
    if (error) return { ok: false, message: error.message };

    // Apple supplies fullName ONLY on the very first authorization. Capture it now
    // or it is gone forever (subsequent sign-ins return null).
    const full = credential.fullName;
    const name = full ? [full.givenName, full.familyName].filter(Boolean).join(' ').trim() : '';
    if (name) getAuthFlow().setPendingDisplayName(name);

    return { ok: true };
  } catch (e: any) {
    // expo-apple-authentication surfaces user cancellation as ERR_REQUEST_CANCELED.
    if (e?.code === 'ERR_REQUEST_CANCELED' || e?.code === 'ERR_CANCELED') {
      return { ok: false, cancelled: true };
    }
    return { ok: false, message: e?.message ?? 'Apple sign-in failed.' };
  }
}
