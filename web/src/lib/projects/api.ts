/**
 * Chamadas HTTP para /api/projects (CRUD + arquivos).
 */
import { getAccessToken } from "@/lib/supabase/auth"
import type {
  CreateProjectInput,
  ProjectFileRecord,
  ProjectSummary,
  UpdateProjectInput,
} from "./types"

const BASE_URL = "/api"

async function authHeaders(
  json = false,
): Promise<Record<string, string>> {
  const token = await getAccessToken()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (json) headers["Content-Type"] = "application/json"
  return headers
}

async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string }
    if (body.message) return body.message
  } catch {
    /* ignore */
  }
  return fallback
}

export async function fetchProjects(
  signal?: AbortSignal,
): Promise<ProjectSummary[]> {
  let response: Response
  try {
    response = await fetch(`${BASE_URL}/projects`, {
      headers: await authHeaders(),
      signal,
    })
  } catch {
    throw new Error(
      "AgentCore inacessível. Confirme que o backend está rodando (porta 8787).",
    )
  }
  if (!response.ok) {
    if (response.status === 401) throw new Error("Sessão inválida. Faça login novamente.")
    if (response.status === 404) {
      throw new Error(
        "GET /api/projects não encontrado (404). Reinicie o AgentCore com o código atual (porta 8787).",
      )
    }
    throw new Error(`GET /api/projects respondeu ${response.status}`)
  }
  return response.json()
}

export async function fetchProject(projectId: string): Promise<ProjectSummary> {
  const response = await fetch(`${BASE_URL}/projects/${projectId}`, {
    headers: await authHeaders(),
  })
  if (!response.ok) {
    throw new Error(await parseError(response, `GET /api/projects/${projectId} falhou`))
  }
  return response.json()
}

export async function createProject(
  input: CreateProjectInput,
): Promise<ProjectSummary> {
  const response = await fetch(`${BASE_URL}/projects`, {
    method: "POST",
    headers: await authHeaders(true),
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error(await parseError(response, `POST /api/projects falhou (${response.status})`))
  }
  return response.json()
}

export async function updateProject(
  projectId: string,
  input: UpdateProjectInput,
): Promise<ProjectSummary> {
  const response = await fetch(`${BASE_URL}/projects/${projectId}`, {
    method: "PATCH",
    headers: await authHeaders(true),
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error(
      await parseError(response, `PATCH /api/projects/${projectId} falhou`),
    )
  }
  return response.json()
}

export async function deleteProject(projectId: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/projects/${projectId}`, {
    method: "DELETE",
    headers: await authHeaders(),
  })
  if (!response.ok) {
    throw new Error(
      await parseError(response, `DELETE /api/projects/${projectId} falhou`),
    )
  }
}

export async function fetchProjectFiles(
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectFileRecord[]> {
  const response = await fetch(`${BASE_URL}/projects/${projectId}/files`, {
    headers: await authHeaders(),
    signal,
  })
  if (!response.ok) {
    throw new Error(
      await parseError(response, `GET /api/projects/${projectId}/files falhou`),
    )
  }
  return response.json()
}

export async function uploadProjectFile(
  projectId: string,
  file: { name: string; mimeType?: string; dataBase64: string },
): Promise<ProjectFileRecord> {
  const response = await fetch(`${BASE_URL}/projects/${projectId}/files`, {
    method: "POST",
    headers: await authHeaders(true),
    body: JSON.stringify(file),
  })
  if (!response.ok) {
    throw new Error(
      await parseError(response, `POST /api/projects/${projectId}/files falhou`),
    )
  }
  return response.json()
}

export async function deleteProjectFile(
  projectId: string,
  fileId: string,
): Promise<void> {
  const response = await fetch(
    `${BASE_URL}/projects/${projectId}/files/${fileId}`,
    {
      method: "DELETE",
      headers: await authHeaders(),
    },
  )
  if (!response.ok) {
    throw new Error(
      await parseError(
        response,
        `DELETE /api/projects/${projectId}/files/${fileId} falhou`,
      ),
    )
  }
}

/** Lê File do browser → base64 (sem prefixo data:). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== "string") {
        reject(new Error("Falha ao ler arquivo."))
        return
      }
      const comma = result.indexOf(",")
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(new Error("Falha ao ler arquivo."))
    reader.readAsDataURL(file)
  })
}
