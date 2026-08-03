/**
 * Registry dos sistemas de negócio que o Dexter pode consultar.
 *
 * URLs são públicas (ficam aqui no código). A `service_role` de cada sistema
 * é SECRET e vem do Infisical pela env indicada em `serviceRoleEnv` — um
 * sistema só fica "ativo" quando sua service_role está presente.
 *
 * O acesso ao dado é SEMPRE via RPC read-only com gate por permissão
 * (ver supabase/rpcs/<slug>/): dexter_whoami(email) + dexter_<...> com escopo.
 */
export interface SystemDef {
  slug: string
  label: string
  supabaseUrl: string
  /** Nome da env (Infisical) que guarda a service_role deste sistema. */
  serviceRoleEnv: string
}

export const SYSTEMS: SystemDef[] = [
  { slug: "networkgo", label: "NetworkGo", supabaseUrl: "https://qgtbxeobqlyptevsckjp.supabase.co", serviceRoleEnv: "NETWORKGO_SERVICE_ROLE_KEY" },
  { slug: "pipego",    label: "PipeGo",    supabaseUrl: "https://xalvwhdkiwuyfrtslxnq.supabase.co", serviceRoleEnv: "PIPEGO_SERVICE_ROLE_KEY" },
  { slug: "godash",    label: "GoDash",    supabaseUrl: "https://xggqzueehfvautkmaojy.supabase.co", serviceRoleEnv: "GODASH_SERVICE_ROLE_KEY" },
  { slug: "mensurego", label: "MensureGo (RH/DP)", supabaseUrl: "https://quzpakmslmcifvpjkdod.supabase.co", serviceRoleEnv: "MENSUREGO_SERVICE_ROLE_KEY" },
  { slug: "checkgo",   label: "CheckGo",   supabaseUrl: "https://zkfcqolkawmpxdyoxvjk.supabase.co", serviceRoleEnv: "CHECKGO_SERVICE_ROLE_KEY" },
  { slug: "expertgo",  label: "ExpertGo",  supabaseUrl: "https://jiktluoucdaaugvlyrfn.supabase.co", serviceRoleEnv: "EXPERTGO_SERVICE_ROLE_KEY" },
  { slug: "supplygo",  label: "SupplyGo",  supabaseUrl: "https://dtcklkhvrsyxjjjmuquw.supabase.co", serviceRoleEnv: "SUPPLYGO_SERVICE_ROLE_KEY" },
  { slug: "qrapido",   label: "QRápido",   supabaseUrl: "https://oxavhvpbjjhaqffhgnyo.supabase.co", serviceRoleEnv: "QRAPIDO_SERVICE_ROLE_KEY" },
  { slug: "sugestoes", label: "Sugestões e Melhorias", supabaseUrl: "https://iwtieifwvhmnbdhamvtx.supabase.co", serviceRoleEnv: "SUGESTOES_SERVICE_ROLE_KEY" },
]

/** service_role do sistema (do Infisical), se cadastrada. */
export function getServiceRole(slug: string): string | undefined {
  const sys = SYSTEMS.find((s) => s.slug === slug)
  if (!sys) return undefined
  const key = process.env[sys.serviceRoleEnv]
  return key && key.length > 0 ? key : undefined
}

/** Sistemas prontos pra uso (service_role presente no ambiente). */
export function configuredSystems(): SystemDef[] {
  return SYSTEMS.filter((s) => getServiceRole(s.slug) !== undefined)
}
