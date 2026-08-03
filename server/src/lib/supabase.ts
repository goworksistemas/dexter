/**
 * Client Supabase com SERVICE ROLE — usado pelo backend para persistir
 * conversas/mensagens/tool-calls e para validar JWTs de usuário via
 * `auth.getUser(jwt)`. Bypassa RLS: nunca expor este client ao frontend.
 */
import { createClient } from "@supabase/supabase-js"

import { config } from "../config.js"

export const supabase = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
)
