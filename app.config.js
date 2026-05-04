/**
 * app.config.js — Lexi-Lens dynamic Expo config
 *
 * Replaces app.json as the config entry point.
 * Reads EXPO_PUBLIC_* env vars at build time — injected by EAS Secrets
 * so they never need to be hardcoded in any committed file.
 *
 * EAS Secrets setup (run once, from project root):
 *   eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL --value "your-url"
 *   eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "your-key"
 *
 * Verify: eas secret:list
 *
 * Local dev: add both vars to your .env.local file (already gitignored).
 */

export default {
  expo: {
    name: "lexi-lens",
    slug: "lexi-lens",
    version: "1.0.11",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "light",
    newArchEnabled: true,

    splash: {
      image: "./assets/splash-icon.png",
      resizeMode: "contain",
      backgroundColor: "#ffffff",
    },

    ios: {
      bundleIdentifier: "com.navinj.lexilens",
      supportsTablet: true,
      entitlements: {
        "aps-environment": "production",
      },
      infoPlist: {
        NSCameraUsageDescription:
          "Lexi-Lens uses your camera to scan real-world objects and bring vocabulary quests to life.",
		ITSAppUsesNonExemptEncryption: false,
      },
    },

    android: {
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#ffffff",
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      permissions: ["android.permission.CAMERA"],
      package: "com.navinj.lexilore",
    },

    web: {
      favicon: "./assets/favicon.png",
    },

    plugins: [
      "react-native-vision-camera",
	  [
        "expo-build-properties",  
        {
          ios: {
            deploymentTarget: "16.0",
          },
        },
      ],
      [
        "@sentry/react-native/expo",
        {
          url: "https://sentry.io/",
          project: "lexi-lens",
          organization: "njlabs",
        },
      ],
    ],

    extra: {
      eas: {
        projectId: "7fe2d61b-242a-4de3-91a7-1422f6876164",
      },
      // These are read at runtime via expo-constants if needed,
      // but the EXPO_PUBLIC_ prefix already makes them available
      // as process.env.EXPO_PUBLIC_SUPABASE_URL in the bundle.
      supabaseUrl:     process.env.EXPO_PUBLIC_SUPABASE_URL,
      supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    },

    updates: {
      fallbackToCacheTimeout: 0,
    },

    owner: "navinj",
    scheme: "lexilens",
  },
};
