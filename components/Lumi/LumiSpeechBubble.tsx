/**
 * components/Lumi/LumiSpeechBubble.tsx
 *
 * Lumi's speech bubble.
 *
 * Behavior:
 *   • Soft fade + slide in (200ms)
 *   • Auto-dismiss after `durationMs` (default 3500ms)
 *   • Tail points back toward Lumi based on `tailSide` prop
 *   • accessibilityLabel mirrors text for screen readers
 *   • Re-renders cleanly when message changes (cancels prior timeout)
 *   • pointerEvents=none so it never blocks touches
 */

import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

export interface LumiSpeechBubbleProps {
  message:      string;
  /** Side of the bubble where the tail attaches (points to Lumi). */
  tailSide?:    'left' | 'right';
  /** Auto-dismiss after this many ms. 0 = stay until message changes. */
  durationMs?:  number;
  /** Container width hint so we wrap nicely on small screens. */
  maxWidth?:    number;
  /** Visible? Driven by parent — toggling triggers fade in/out. */
  visible:      boolean;
}

export function LumiSpeechBubble(props: LumiSpeechBubbleProps): React.ReactElement | null {
  const {
    message,
    tailSide   = 'left',
    durationMs = 3500,
    maxWidth   = 200,
    visible,
  } = props;

  const opacity   = useSharedValue(0);
  const translate = useSharedValue(6);

  useEffect(() => {
    if (!visible || !message) {
      opacity.value   = withTiming(0, { duration: 160 });
      translate.value = withTiming(6, { duration: 160 });
      return;
    }
    opacity.value   = withTiming(1, { duration: 200, easing: Easing.out(Easing.cubic) });
    translate.value = withTiming(0, { duration: 200, easing: Easing.out(Easing.cubic) });

    if (durationMs > 0) {
      opacity.value   = withDelay(durationMs, withTiming(0, { duration: 240 }));
      translate.value = withDelay(durationMs, withTiming(6, { duration: 240 }));
    }
  }, [visible, message, durationMs]);

  const aStyle = useAnimatedStyle(() => ({
    opacity:   opacity.value,
    transform: [{ translateY: translate.value }],
  }));

  if (!message) return null;

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityRole="text"
      accessibilityLabel={`Lumi says: ${message}`}
      style={[styles.bubble, { maxWidth }, aStyle]}
    >
      <Text style={styles.text} numberOfLines={3}>
        {message}
      </Text>
      <View style={[styles.tail, tailSide === 'left' ? styles.tailLeft : styles.tailRight]} />
    </Animated.View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
// Palette aligned with LexiLens roadmap tokens:
//   bg-card-2 #281a45 → bubble fill
//   text      #f3e8ff → bubble text
//   accent    #f5c842 → bubble border accent

const styles = StyleSheet.create({
  bubble: {
    backgroundColor: 'rgba(40, 26, 69, 0.95)',
    borderColor:     '#f5c842',
    borderWidth:     1.5,
    borderRadius:    14,
    paddingVertical: 8,
    paddingHorizontal: 12,
    // soft glow
    shadowColor:    '#f5c842',
    shadowOpacity:  0.35,
    shadowRadius:   6,
    shadowOffset:   { width: 0, height: 0 },
    elevation:      4,
  },
  text: {
    color:      '#f3e8ff',
    fontSize:   13,
    lineHeight: 17,
    fontWeight: '600',
  },
  tail: {
    position:        'absolute',
    bottom:          -6,
    width:           10,
    height:          10,
    backgroundColor: 'rgba(40, 26, 69, 0.95)',
    borderRightWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor:      '#f5c842',
    transform:        [{ rotate: '45deg' }],
  },
  tailLeft:  { left:  16 },
  tailRight: { right: 16 },
});
