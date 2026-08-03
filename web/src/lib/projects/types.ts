/**
 * Tipos de projetos do Dexter — espelham GET/POST /api/projects e arquivos.
 */

export interface ProjectSummary {
  id: string
  name: string
  instructions: string
  color: string | null
  icon: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface ProjectFileRecord {
  id: string
  project_id: string
  name: string
  storage_path: string
  mime_type: string | null
  size_bytes: number
  created_at: string
}

export interface CreateProjectInput {
  name: string
  instructions?: string
  color?: string | null
  icon?: string | null
}

export interface UpdateProjectInput {
  name?: string
  instructions?: string
  color?: string | null
  icon?: string | null
}

/** Paleta sugerida para a cor do projeto na sidebar. */
export const PROJECT_COLORS = [
  "#0F766E",
  "#0369A1",
  "#B45309",
  "#B91C1C",
  "#7C3AED",
  "#15803D",
  "#C2410C",
  "#334155",
] as const
