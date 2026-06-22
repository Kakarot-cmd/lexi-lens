/**
 * KeyboardAware.tsx
 * Skanlore — cross-platform keyboard avoidance (no native dependency).
 *
 * WHY THIS EXISTS
 * ---------------
 * The app sets `android.edgeToEdgeEnabled: true` (Expo SDK 54 / RN 0.81 default
 * on Android 15 / API 35). Under edge-to-edge, the legacy `adjustResize`
 * softInputMode NO LONGER resizes the window when the IME appears — Android now
 * assumes the app consumes the keyboard inset itself. Consequently the old
 * project-wide pattern:
 *
 *     <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
 *
 * does nothing on Android (behavior=undefined relies on adjustResize, which is
 * dead), and React Native's <Modal> runs in its own native window that never
 * inherited the Activity's softInputMode anyway. Net effect on both counts:
 * the keyboard overlaps inputs — exactly the reported bug.
 *
 * This module fixes it purely in JS (works with `react-native-safe-area-context`
 * 5.x, which already tracks the IME inset), so NO `expo prebuild --clean`, NO
 * re-applying the Xcode-26 fixes, NO new native pod. It ships in a normal build.
 *
 * EXPORTS
 * -------
 *   <KeyboardAwareScrollView/>  Drop-in replacement for <ScrollView> on screens
 *                               and modal bodies that scroll. iOS uses the native
 *                               `automaticallyAdjustKeyboardInsets` (auto-scrolls
 *                               the focused field into view); Android tracks the
 *                               keyboard height, pads the content, and best-effort
 *                               scrolls the focused input above the keyboard.
 *
 *   <KeyboardAwareView/>        For bottom-sheet overlays that do NOT scroll
 *                               (e.g. the PIN gate). Lifts its content up by the
 *                               keyboard height. Use it to wrap a flex-end overlay.
 *
 * Both animate in sync with the keyboard and are safe inside <Modal>.
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  Animated,
  Dimensions,
  Keyboard,
  KeyboardEvent,
  Platform,
  ScrollView,
  ScrollViewProps,
  StyleProp,
  TextInput,
  ViewStyle,
} from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

const IS_IOS = Platform.OS === "ios";

/** Keyboard show/hide event names. iOS fires the `will*` pair (smoother). */
const SHOW_EVT = IS_IOS ? "keyboardWillShow" : "keyboardDidShow";
const HIDE_EVT = IS_IOS ? "keyboardWillHide" : "keyboardDidHide";

/** Subscribe to keyboard height. Returns animated height + raw px height. */
function useKeyboardHeight() {
  const animated = useRef(new Animated.Value(0)).current;
  const [height, setHeight] = useState(0);
  const [top, setTop] = useState(0);

  useEffect(() => {
    const onShow = (e: KeyboardEvent) => {
      const h = e?.endCoordinates?.height ?? 0;
      setHeight(h);
      setTop(e?.endCoordinates?.screenY ?? 0);
      Animated.timing(animated, {
        toValue: h,
        duration: IS_IOS ? e?.duration ?? 250 : 160,
        useNativeDriver: false, // animating layout (padding/height), not transform
      }).start();
    };
    const onHide = (e: KeyboardEvent) => {
      setHeight(0);
      setTop(0);
      Animated.timing(animated, {
        toValue: 0,
        duration: IS_IOS ? e?.duration ?? 250 : 160,
        useNativeDriver: false,
      }).start();
    };

    const showSub = Keyboard.addListener(SHOW_EVT, onShow);
    const hideSub = Keyboard.addListener(HIDE_EVT, onHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [animated]);

  return { animated, height, top };
}

// ─────────────────────────────────────────────────────────────────────────────
// KeyboardAwareView — lifts a non-scrolling bottom sheet above the keyboard.
// ─────────────────────────────────────────────────────────────────────────────

interface KeyboardAwareViewProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Extra gap (px) between the keyboard top and the lifted content. */
  extraOffset?: number;
}

export function KeyboardAwareView({
  children,
  style,
  extraOffset = 0,
}: KeyboardAwareViewProps) {
  const { animated } = useKeyboardHeight();
  const pad = extraOffset > 0 ? Animated.add(animated, extraOffset) : animated;

  // Padding the bottom of a flex-end overlay raises the sheet by the IME height
  // on BOTH platforms. Works inside <Modal> because it never relies on the
  // Activity's softInputMode.
  return (
    <Animated.View style={[{ flex: 1 }, style, { paddingBottom: pad }]}>
      {children}
    </Animated.View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// KeyboardAwareScrollView — drop-in <ScrollView> that keeps inputs visible.
// ─────────────────────────────────────────────────────────────────────────────

interface KeyboardAwareScrollViewProps extends ScrollViewProps {
  /** Gap (px) kept between the focused input and the keyboard top (Android). */
  extraScrollOffset?: number;
}

export const KeyboardAwareScrollView = forwardRef<
  ScrollView,
  KeyboardAwareScrollViewProps
>(function KeyboardAwareScrollView(
  {
    children,
    extraScrollOffset = 24,
    contentContainerStyle,
    keyboardShouldPersistTaps = "handled",
    keyboardDismissMode,
    onScroll,
    scrollEventThrottle,
    ...rest
  },
  ref
) {
  const innerRef = useRef<ScrollView>(null);
  useImperativeHandle(ref, () => innerRef.current as ScrollView);

  const { height: kbHeight, top: kbTop } = useKeyboardHeight();

  // Track the live scroll offset so we can convert a window-space measurement
  // into an absolute scrollTo target. Merged with any consumer onScroll.
  const scrollY = useRef(0);
  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollY.current = e?.nativeEvent?.contentOffset?.y ?? scrollY.current;
      onScroll?.(e);
    },
    [onScroll]
  );

  // Android only: when the keyboard opens, pad the content so the focused
  // field can sit above it, then scroll the focused input into view.
  //
  // We use measureInWindow (absolute window coords) rather than measureLayout.
  // measureLayout requires its relative target to resolve to a *native*
  // component instance; passing a node handle warns on the New Architecture
  // ("ref.measureLayout must be called with a ref to a native component") on
  // every focus. measureInWindow has no such requirement and is warning-free.
  useEffect(() => {
    if (IS_IOS || kbHeight <= 0) return;

    // Defer a frame so layout has settled with the new padding.
    const id = requestAnimationFrame(() => {
      try {
        const focused = (TextInput as any).State?.currentlyFocusedInput?.();
        const scroll = innerRef.current as any;
        if (!focused || !scroll || typeof focused.measureInWindow !== "function") return;

        focused.measureInWindow((_x: number, y: number, _w: number, h: number) => {
          if (typeof y !== "number" || typeof h !== "number") return;
          // Keyboard top in window coords: prefer the event's screenY, fall
          // back to window height minus keyboard height.
          const keyboardTop =
            kbTop > 0 ? kbTop : Dimensions.get("window").height - kbHeight;
          const overlap = y + h - (keyboardTop - extraScrollOffset);
          if (overlap > 0) {
            scroll.scrollTo?.({ y: scrollY.current + overlap, animated: true });
          }
        });
      } catch {
        /* never let keyboard handling crash a screen */
      }
    });

    return () => cancelAnimationFrame(id);
  }, [kbHeight, kbTop, extraScrollOffset]);

  const androidPad =
    !IS_IOS && kbHeight > 0 ? { paddingBottom: kbHeight + extraScrollOffset } : null;

  return (
    <ScrollView
      ref={innerRef}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      keyboardDismissMode={keyboardDismissMode ?? (IS_IOS ? "interactive" : "on-drag")}
      // iOS does the heavy lifting natively: insets the scroll for the IME and
      // scrolls the focused field into view. (no-op on Android)
      automaticallyAdjustKeyboardInsets={IS_IOS}
      onScroll={handleScroll}
      scrollEventThrottle={scrollEventThrottle ?? 16}
      contentContainerStyle={[contentContainerStyle, androidPad]}
      {...rest}
    >
      {children}
    </ScrollView>
  );
});

/**
 * useKeyboardVisible — small helper if a screen needs to hide a fixed footer
 * or shrink chrome while the keyboard is open. Not required for avoidance.
 */
export function useKeyboardVisible() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const s = Keyboard.addListener(SHOW_EVT, () => setVisible(true));
    const h = Keyboard.addListener(HIDE_EVT, () => setVisible(false));
    return () => {
      s.remove();
      h.remove();
    };
  }, []);
  return visible;
}

export default KeyboardAwareScrollView;
