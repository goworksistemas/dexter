/**
 * Persistência de projetos e arquivos do AgentCore via Supabase (service role).
 * Tabelas: agent_projects, agent_project_files + bucket Storage `project-files`.
 * Ownership obrigatório — service_role bypassa RLS.
 */
import { randomUUID } from "node:crypto"

import { supabase } from "../lib/supabase.js"
import { ForbiddenError, NotFoundError } from "./auth.js"

const BUCKET = "project-files"
/**
 * Teto por leitura da tool `project__read_file`. O conteúdo dos arquivos NÃO
 * vai mais no system prompt (custava até 48k chars em toda mensagem) — o
 * modelo lê o que precisar, quando precisar.
 */
export const PROJECT_FILE_READ_MAX_CHARS = 24_000
const MAX_FILE_BYTES = 10 * 1024 * 1024
const TEXT_MIME_PREFIXES = ["text/"]
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".log",
])

export interface ProjectRecord {
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

export interface CreateProjectParams {
  userId: string
  name: string
  instructions?: string
  color?: string | null
  icon?: string | null
}

export interface UpdateProjectParams {
  name?: string
  instructions?: string
  color?: string | null
  icon?: string | null
}

export interface UploadProjectFileParams {
  projectId: string
  userId: string
  name: string
  mimeType?: string
  dataBase64: string
}

async function assertProjectOwned(
  projectId: string,
  userId: string,
): Promise<ProjectRecord> {
  const { data, error } = await supabase
    .from("agent_projects")
    .select(
      "id, user_id, name, instructions, color, icon, metadata, created_at, updated_at",
    )
    .eq("id", projectId)
    .maybeSingle()

  if (error) {
    throw new Error(`assertProjectOwned falhou: ${error.message}`)
  }
  if (!data) {
    throw new NotFoundError("Projeto não encontrado.")
  }
  if (data.user_id !== userId) {
    throw new ForbiddenError("Este projeto não pertence ao usuário autenticado.")
  }
  const { user_id: _uid, ...rest } = data
  return rest as ProjectRecord
}

/** Lista projetos do usuário, mais recentes primeiro. */
export async function listProjects(userId: string): Promise<ProjectRecord[]> {
  const { data, error } = await supabase
    .from("agent_projects")
    .select("id, name, instructions, color, icon, metadata, created_at, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })

  if (error) {
    throw new Error(`listProjects falhou: ${error.message}`)
  }
  return (data ?? []) as ProjectRecord[]
}

/** Detalhe do projeto (ownership). */
export async function getProject(
  projectId: string,
  userId: string,
): Promise<ProjectRecord> {
  return assertProjectOwned(projectId, userId)
}

/** Cria projeto. */
export async function createProject(
  params: CreateProjectParams,
): Promise<ProjectRecord> {
  const name = params.name.trim()
  const row = {
    user_id: params.userId,
    name,
    instructions: params.instructions?.trim() ?? "",
    color: params.color ?? null,
    icon: params.icon ?? null,
  }

  const { data, error } = await supabase
    .from("agent_projects")
    .insert(row)
    .select("id, name, instructions, color, icon, metadata, created_at, updated_at")
    .single()

  if (error) {
    throw new Error(`createProject falhou: ${error.message}`)
  }
  return data as ProjectRecord
}

/** Atualiza campos do projeto. */
export async function updateProject(
  projectId: string,
  userId: string,
  patch: UpdateProjectParams,
): Promise<ProjectRecord> {
  await assertProjectOwned(projectId, userId)

  const row: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (patch.name !== undefined) row.name = patch.name.trim()
  if (patch.instructions !== undefined) row.instructions = patch.instructions
  if (patch.color !== undefined) row.color = patch.color
  if (patch.icon !== undefined) row.icon = patch.icon

  const { data, error } = await supabase
    .from("agent_projects")
    .update(row)
    .eq("id", projectId)
    .eq("user_id", userId)
    .select("id, name, instructions, color, icon, metadata, created_at, updated_at")
    .maybeSingle()

  if (error) {
    throw new Error(`updateProject falhou: ${error.message}`)
  }
  if (!data) {
    throw new NotFoundError("Projeto não encontrado.")
  }
  return data as ProjectRecord
}

/**
 * Exclui o projeto. Chats ficam com project_id null (ON DELETE SET NULL);
 * arquivos e storage são removidos.
 */
export async function deleteProject(
  projectId: string,
  userId: string,
): Promise<boolean> {
  await assertProjectOwned(projectId, userId)

  const files = await listProjectFiles(projectId, userId)
  if (files.length > 0) {
    const paths = files.map((f) => f.storage_path)
    const { error: storageErr } = await supabase.storage
      .from(BUCKET)
      .remove(paths)
    if (storageErr) {
      // Melhor esforço: segue com delete do registro mesmo se storage falhar.
      console.error(`deleteProject storage cleanup: ${storageErr.message}`)
    }
  }

  const { error, count } = await supabase
    .from("agent_projects")
    .delete({ count: "exact" })
    .eq("id", projectId)
    .eq("user_id", userId)

  if (error) {
    throw new Error(`deleteProject falhou: ${error.message}`)
  }
  return (count ?? 0) > 0
}

/** Lista arquivos do projeto. */
export async function listProjectFiles(
  projectId: string,
  userId: string,
): Promise<ProjectFileRecord[]> {
  await assertProjectOwned(projectId, userId)

  const { data, error } = await supabase
    .from("agent_project_files")
    .select("id, project_id, name, storage_path, mime_type, size_bytes, created_at")
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`listProjectFiles falhou: ${error.message}`)
  }
  return (data ?? []) as ProjectFileRecord[]
}

function isTextFile(name: string, mimeType?: string | null): boolean {
  const lower = name.toLowerCase()
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : ""
  if (TEXT_EXTENSIONS.has(ext)) return true
  if (mimeType && TEXT_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) {
    return true
  }
  if (mimeType === "application/json" || mimeType === "application/xml") {
    return true
  }
  return false
}

/** Upload de arquivo (base64) para Storage + metadados. */
export async function uploadProjectFile(
  params: UploadProjectFileParams,
): Promise<ProjectFileRecord> {
  await assertProjectOwned(params.projectId, params.userId)

  const name = params.name.trim()
  if (!name) {
    throw Object.assign(new Error("Nome do arquivo é obrigatório."), {
      statusCode: 400,
    })
  }

  let bytes: Buffer
  try {
    bytes = Buffer.from(params.dataBase64, "base64")
  } catch {
    throw Object.assign(new Error("dataBase64 inválido."), { statusCode: 400 })
  }
  if (bytes.length === 0) {
    throw Object.assign(new Error("Arquivo vazio."), { statusCode: 400 })
  }
  if (bytes.length > MAX_FILE_BYTES) {
    throw Object.assign(
      new Error(`Arquivo excede o limite de ${MAX_FILE_BYTES} bytes.`),
      { statusCode: 400 },
    )
  }

  const fileId = randomUUID()
  const safeName = name.replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 200)
  const storagePath = `${params.userId}/${params.projectId}/${fileId}-${safeName}`
  const mimeType = params.mimeType || "application/octet-stream"

  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, bytes, {
      contentType: mimeType,
      upsert: false,
    })
  if (uploadErr) {
    throw new Error(`uploadProjectFile storage falhou: ${uploadErr.message}`)
  }

  const { data, error } = await supabase
    .from("agent_project_files")
    .insert({
      id: fileId,
      project_id: params.projectId,
      user_id: params.userId,
      name,
      storage_path: storagePath,
      mime_type: mimeType,
      size_bytes: bytes.length,
    })
    .select("id, project_id, name, storage_path, mime_type, size_bytes, created_at")
    .single()

  if (error) {
    await supabase.storage.from(BUCKET).remove([storagePath])
    throw new Error(`uploadProjectFile metadados falhou: ${error.message}`)
  }

  // Touch updated_at do projeto
  await supabase
    .from("agent_projects")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", params.projectId)
    .eq("user_id", params.userId)

  return data as ProjectFileRecord
}

/** Remove arquivo do Storage e metadados. */
export async function deleteProjectFile(
  projectId: string,
  fileId: string,
  userId: string,
): Promise<boolean> {
  await assertProjectOwned(projectId, userId)

  const { data, error } = await supabase
    .from("agent_project_files")
    .select("id, storage_path")
    .eq("id", fileId)
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .maybeSingle()

  if (error) {
    throw new Error(`deleteProjectFile lookup falhou: ${error.message}`)
  }
  if (!data) return false

  const { error: storageErr } = await supabase.storage
    .from(BUCKET)
    .remove([data.storage_path])
  if (storageErr) {
    console.error(`deleteProjectFile storage: ${storageErr.message}`)
  }

  const { error: delErr, count } = await supabase
    .from("agent_project_files")
    .delete({ count: "exact" })
    .eq("id", fileId)
    .eq("project_id", projectId)
    .eq("user_id", userId)

  if (delErr) {
    throw new Error(`deleteProjectFile falhou: ${delErr.message}`)
  }
  return (count ?? 0) > 0
}

/**
 * Monta o bloco de contexto do projeto para o system prompt:
 * instruções + ÍNDICE dos arquivos (id, nome, tipo, tamanho). O conteúdo sai
 * sob demanda pela tool `project__read_file` — injetar tudo aqui reenviava
 * dezenas de milhares de chars a cada mensagem da conversa.
 */
export async function buildProjectPromptBlock(
  projectId: string,
  userId: string,
): Promise<string | null> {
  let project: ProjectRecord
  try {
    project = await assertProjectOwned(projectId, userId)
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ForbiddenError) {
      return null
    }
    throw err
  }

  const files = await listProjectFiles(projectId, userId)
  const parts: string[] = []

  parts.push("## Instruções do projeto")
  parts.push(
    project.instructions.trim()
      ? project.instructions.trim()
      : "(sem instruções customizadas)",
  )
  parts.push(`\nProjeto: "${project.name}"`)

  if (files.length === 0) {
    parts.push("\n## Arquivos do projeto\n(nenhum arquivo anexado)")
    return parts.join("\n")
  }

  parts.push("\n## Arquivos do projeto")
  for (const f of files) {
    const tipo = f.mime_type ?? "tipo desconhecido"
    const legivel = isTextFile(f.name, f.mime_type) ? "" : " · não é texto"
    parts.push(
      `- ${f.name} (${tipo}, ${f.size_bytes} bytes${legivel}) — file_id: ${f.id}`,
    )
  }
  parts.push(
    "\nO conteúdo dos arquivos NÃO está neste prompt. Para ler qualquer um " +
      "deles, chame a tool `project__read_file` com o `file_id` da lista acima. " +
      "Leia antes de responder qualquer coisa que dependa do conteúdo — não " +
      "suponha o que está dentro do arquivo pelo nome.",
  )

  return parts.join("\n")
}

export interface ProjectFileContent {
  name: string
  mimeType: string | null
  sizeBytes: number
  content: string
  truncated: boolean
}

/**
 * Lê o conteúdo textual de um arquivo do projeto (tool `project__read_file`).
 * Ownership do projeto E do arquivo; binário/PDF é recusado com mensagem clara.
 * Conteúdo cortado em `PROJECT_FILE_READ_MAX_CHARS` por leitura.
 */
export async function readProjectFileText(
  projectId: string,
  fileId: string,
  userId: string,
): Promise<ProjectFileContent> {
  await assertProjectOwned(projectId, userId)

  const { data, error } = await supabase
    .from("agent_project_files")
    .select("id, project_id, name, storage_path, mime_type, size_bytes, created_at")
    .eq("id", fileId)
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .maybeSingle()

  if (error) {
    throw new Error(`readProjectFileText lookup falhou: ${error.message}`)
  }
  if (!data) {
    throw new NotFoundError(
      "Arquivo não encontrado neste projeto. Use um file_id do índice de arquivos.",
    )
  }

  const file = data as ProjectFileRecord
  if (!isTextFile(file.name, file.mime_type)) {
    throw Object.assign(
      new Error(
        `"${file.name}" (${file.mime_type ?? "tipo desconhecido"}) não é um arquivo de texto — ` +
          "leitura de binário/PDF não é suportada. Peça ao usuário para anexar o conteúdo na conversa.",
      ),
      { statusCode: 400 },
    )
  }

  const { data: blob, error: downloadErr } = await supabase.storage
    .from(BUCKET)
    .download(file.storage_path)
  if (downloadErr || !blob) {
    throw new Error(
      `não foi possível baixar "${file.name}": ${downloadErr?.message ?? "arquivo indisponível"}`,
    )
  }

  const raw = await blob.text()
  const truncated = raw.length > PROJECT_FILE_READ_MAX_CHARS
  return {
    name: file.name,
    mimeType: file.mime_type,
    sizeBytes: file.size_bytes,
    content: truncated ? raw.slice(0, PROJECT_FILE_READ_MAX_CHARS) : raw,
    truncated,
  }
}

/** Valida se o projectId existe e pertence ao usuário (para upsert de chat). */
export async function assertProjectOwnedOrThrow(
  projectId: string,
  userId: string,
): Promise<void> {
  await assertProjectOwned(projectId, userId)
}
