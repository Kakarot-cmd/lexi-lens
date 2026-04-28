/**
 * components/ErrorBoundary.tsx
 * Lexi-Lens — Phase 3.7: Sentry Crash Reporting
 *
 * A React class error boundary that:
 *   1. Catches unhandled JS errors inside any child component tree.
 *   2. Reports them to Sentry with Lexi-Lens game context.
 *   3. Shows a child-friendly "Magic went wrong" fallback screen
 *      with a "Try again" button that resets the boundary state.
 *
 * Usage — wrap individual screens for granular error isolation:
 *
 *   <ErrorBoundary screen="ScanScreen">
 *     <ScanScreen ... />
 *   </ErrorBoundary>
 *
 * Or wrap the entire app in App.tsx for a global catch-all:
 *
 *   <ErrorBoundary screen="App">
 *     <NavigationContainer>...</NavigationContainer>
 *   </ErrorBoundary>
 *
 * NOTE: Sentry.wrap() in App.tsx already provides an outer boundary.
 * This component adds per-screen granularity so crashes are attributed
 * to the right screen in the Sentry issue list.
 */

import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
} from "react-native";
import { captureGameError, addGameBreadcrumb } from "../lib/sentry";

// ─── Props / State ────────────────────────────────────────────────────────────

interface Props {
  /** Screen name shown in Sentry's error_context tag. */
  screen: string;
  children: React.ReactNode;
  /** Optional custom fallback — defaults to the built-in wizard screen. */
  fallback?: React.ReactNode;
}

interface State {
  hasError:   boolean;
  errorMsg:   string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMsg: "" };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, errorMsg: error.message ?? "Unknown error" };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    addGameBreadcrumb({
      category: "navigation",
      message:  `ErrorBoundary caught in ${this.props.screen}`,
      level:    "error",
      data:     { componentStack: info.componentStack?.slice(0, 500) },
    });

    captureGameError(error, {
      context:          "error_boundary",
      screen:           this.props.screen,
      componentStack:   info.componentStack?.slice(0, 500) ?? "",
    });
  }

  handleReset = (): void => {
    this.setState({ hasError: false, errorMsg: "" });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback;
    }

    return (
      <View style={styles.container}>
        {/* Wizard emoji as a stand-in until a Lottie asset is available */}
        <Text style={styles.emoji}>🧙‍♂️</Text>

        <Text style={styles.title}>The magic misfired!</Text>
        <Text style={styles.subtitle}>
          Something unexpected happened in {this.props.screen}.{"\n"}
          The wizards have been notified.
        </Text>

        {__DEV__ && (
          <Text style={styles.devError} numberOfLines={4}>
            {this.state.errorMsg}
          </Text>
        )}

        <TouchableOpacity
          style={styles.button}
          onPress={this.handleReset}
          activeOpacity={0.8}
        >
          <Text style={styles.buttonText}>✦ Try Again</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex:            1,
    backgroundColor: "#0d0221",          // matches app dark theme
    alignItems:      "center",
    justifyContent:  "center",
    padding:         32,
  },
  emoji: {
    fontSize:     72,
    marginBottom: 16,
  },
  title: {
    fontSize:     24,
    fontWeight:   "700",
    color:        "#f0c060",             // golden — matches VerdictCard palette
    textAlign:    "center",
    marginBottom: 8,
  },
  subtitle: {
    fontSize:     15,
    color:        "#a08888",
    textAlign:    "center",
    lineHeight:   22,
    marginBottom: 24,
  },
  devError: {
    fontSize:        11,
    color:           "#ff6666",
    fontFamily:      "monospace",
    backgroundColor: "#1a0a0a",
    padding:         12,
    borderRadius:    8,
    marginBottom:    20,
    alignSelf:       "stretch",
  },
  button: {
    backgroundColor: "#7c3aed",         // purple — matches QuestMap CTA
    paddingVertical: 14,
    paddingHorizontal: 36,
    borderRadius:    24,
  },
  buttonText: {
    color:      "#ffffff",
    fontSize:   16,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
});
