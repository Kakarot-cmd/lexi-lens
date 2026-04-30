export default ({ config }) => ({
  ...config,
  extra: {
    supabaseUrl:     process.env.EXPO_PUBLIC_SUPABASE_URL     ?? "",
    supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "",
    eas: {
      projectId: "7fe2d61b-242a-4de3-91a7-1422f6876164",
    },
  },
});