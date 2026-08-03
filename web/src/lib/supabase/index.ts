export { supabase, hasSupabase, requireSupabase } from "./client"
export * from "./auth"
export {
  fetchUserProfile,
  ensureProfileFromUser,
  updateProfileName,
  updateProfilePreferences,
  updateProfileTheme,
} from "./profile"
