/**
 * components/SocialAuthButtons.tsx
 * Skanlore — Google + Apple sign-in buttons for AuthScreen.
 *
 * Rendering rules
 * ───────────────
 *   • Google  — shown on both platforms when the build has a Web client ID
 *               (isGoogleEnabled()). Custom button in the app's parchment
 *               palette; the multicolour "G" is Google's sanctioned sign-in
 *               mark for exactly this use.
 *   • Apple   — shown only on iOS where Sign in with Apple is available
 *               (iOS 13+). Uses Apple's OFFICIAL native button, which is both
 *               an Apple HIG requirement and what App Store review expects.
 *               Offering Apple alongside Google here is what keeps us clear of
 *               Guideline 4.8 (third-party login must be matched by an
 *               equivalent privacy-preserving option).
 *
 * The component owns no auth logic — it just calls back into AuthScreen, which
 * routes new users through the COPPA consent gate.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import * as AppleAuthentication from 'expo-apple-authentication';

import { isAppleAuthAvailable, isGoogleEnabled } from '../lib/socialAuth';

const P = {
  cream:      '#fdf8f0',
  warmBorder: '#e2d0b0',
  inkBrown:   '#3d2a0f',
  inkLight:   '#9c7540',
  white:      '#ffffff',
} as const;

interface Props {
  onGoogle: () => void;
  onApple: () => void;
  /** Which social provider is mid-flight ('google' | 'apple'), or null. */
  loading: 'google' | 'apple' | null;
  /** True when the email form is busy — disables social buttons too. */
  disabled?: boolean;
}

function GoogleGlyph() {
  // Google's standard four-colour "G" (sanctioned for Sign-in-with-Google buttons).
  return (
    <Svg width={18} height={18} viewBox="0 0 48 48">
      <Path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
      <Path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" />
      <Path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z" />
      <Path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z" />
    </Svg>
  );
}

export function SocialAuthButtons({ onGoogle, onApple, loading, disabled }: Props) {
  const googleOn = isGoogleEnabled();
  const [appleOn, setAppleOn] = useState(false);

  useEffect(() => {
    let alive = true;
    isAppleAuthAvailable().then((v) => { if (alive) setAppleOn(v); });
    return () => { alive = false; };
  }, []);

  if (!googleOn && !appleOn) return null;

  const busy = loading !== null || disabled;

  return (
    <View style={styles.wrap}>
      <View style={styles.dividerRow}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or continue with</Text>
        <View style={styles.dividerLine} />
      </View>

      {googleOn && (
        <TouchableOpacity
          style={[styles.googleBtn, busy && styles.btnDisabled]}
          onPress={onGoogle}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Continue with Google"
        >
          {loading === 'google' ? (
            <ActivityIndicator color={P.inkBrown} />
          ) : (
            <>
              <GoogleGlyph />
              <Text style={styles.googleText}>Continue with Google</Text>
            </>
          )}
        </TouchableOpacity>
      )}

      {appleOn && Platform.OS === 'ios' && (
        loading === 'apple' ? (
          <View style={[styles.appleBtn, styles.appleBusy]}>
            <ActivityIndicator color={P.white} />
          </View>
        ) : (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
            cornerRadius={14}
            style={[styles.appleBtn, busy && styles.btnDisabled]}
            onPress={busy ? undefined : onApple}
          />
        )
      )}

      <Text style={styles.parentNote}>
        Use a grown-up&rsquo;s Google or Apple account — this signs in the parent, not the child.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 18 },

  dividerRow:  { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  dividerLine: { flex: 1, height: 1, backgroundColor: P.warmBorder },
  dividerText: { marginHorizontal: 12, fontSize: 12, color: P.inkLight, fontWeight: '600' },

  googleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    height: 52,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: P.warmBorder,
    backgroundColor: P.white,
    marginBottom: 12,
  },
  googleText: { fontSize: 16, fontWeight: '700', color: P.inkBrown },

  appleBtn:  { height: 52, width: '100%' },
  appleBusy: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000000',
    borderRadius: 14,
  },

  btnDisabled: { opacity: 0.5 },

  parentNote: {
    fontSize: 11,
    color: P.inkLight,
    textAlign: 'center',
    marginTop: 14,
    lineHeight: 16,
  },
});
