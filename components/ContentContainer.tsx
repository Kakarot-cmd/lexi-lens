/**
 * components/ContentContainer.tsx
 * Skanlore — Tablet content-centering primitive (issue #3b)
 *
 * PURPOSE
 * ───────
 * On a phone, app content should fill the width. On a tablet / iPad split-view,
 * a full-bleed phone layout looks broken — buttons stretch the whole panel and
 * line lengths get unreadable. This wrapper centers content into a readable
 * max-width column on large screens, while the screen's own background stays
 * full-bleed behind it (the intended tablet look).
 *
 * SAFETY CONTRACT
 * ───────────────
 *   • On phones (shortest side < TABLET_MIN_WIDTH) this is a PURE PASS-THROUGH:
 *     width 100%, no maxWidth, no alignment change. It cannot alter a phone
 *     layout. Since the app is portrait-locked and the overwhelming majority of
 *     users are on phones, the blast radius of adding this wrapper is near-zero.
 *   • On tablets it applies `maxWidth` + `alignSelf: 'center'` only.
 *   • Reactive: re-centers correctly on rotation / fold / split-view resize.
 *
 * USAGE
 * ─────
 * Wrap the *content* of a screen (not the full-bleed background, not a camera
 * or map surface). Inside a ScrollView, wrap the scroll's children:
 *
 *   <KeyboardAwareScrollView contentContainerStyle={...}>
 *     <ContentContainer>
 *       ...screen content...
 *     </ContentContainer>
 *   </KeyboardAwareScrollView>
 *
 * Do NOT use on ScanScreen (camera), QuestMapScreen (immersive map), or the
 * Onboarding pager / Victory animation — those are full-bleed by design.
 */

import React from 'react';
import { View, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { useResponsive, CONTENT_MAX_WIDTH } from '../utils/responsive';

interface ContentContainerProps {
  children: React.ReactNode;
  /** Override the centered column width on tablet. Defaults to CONTENT_MAX_WIDTH. */
  maxWidth?: number;
  style?: StyleProp<ViewStyle>;
}

export function ContentContainer({ children, maxWidth = CONTENT_MAX_WIDTH, style }: ContentContainerProps) {
  const { isTablet } = useResponsive();

  return (
    <View
      style={[
        styles.base,
        isTablet && { maxWidth, alignSelf: 'center' },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    width: '100%',
  },
});

export default ContentContainer;
