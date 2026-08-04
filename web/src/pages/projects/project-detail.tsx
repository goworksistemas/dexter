import * as React from "react"
import {
  FileText,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Trash2,
  Upload,
} from "lucide-react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"

import { PageHeading, PageShell } from "@/components/layout/page-shell"
import { ProjectComposer } from "@/components/projects/project-composer"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useChats } from "@/lib/chats"
import { formatBytes, formatDate, formatDateTime } from "@/lib/format"
import {
  deleteProjectFile,
  fetchProjectFiles,
  fileToBase64,
  PROJECT_COLORS,
  uploadProjectFile,
  useProjects,
  type ProjectFileRecord,
} from "@/lib/projects"
import { cn } from "@/lib/utils"

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

function extensionBadge(name: string): string {
  const dot = name.lastIndexOf(".")
  if (dot < 0 || dot === name.length - 1) return "FILE"
  return name
    .slice(dot + 1)
    .slice(0, 4)
    .toUpperCase()
}

export function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const { projects, isLoadingProjects, updateProject, deleteProject } =
    useProjects()
  const { chats, selectChat, newChat, newChatWithMessage, refreshChats } =
    useChats()

  const project = projects.find((p) => p.id === projectId)

  const [name, setName] = React.useState("")
  const [instructions, setInstructions] = React.useState("")
  const [color, setColor] = React.useState<string | null>(PROJECT_COLORS[0])
  const [saving, setSaving] = React.useState(false)
  const [files, setFiles] = React.useState<ProjectFileRecord[]>([])
  const [loadingFiles, setLoadingFiles] = React.useState(false)
  const [filesError, setFilesError] = React.useState<string | null>(null)
  const [filesReloadToken, setFilesReloadToken] = React.useState(0)
  const [uploading, setUploading] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!project) return
    setName(project.name)
    setInstructions(project.instructions ?? "")
    setColor(project.color ?? PROJECT_COLORS[0])
  }, [project])

  React.useEffect(() => {
    if (!projectId) return
    const controller = new AbortController()
    setLoadingFiles(true)
    setFilesError(null)
    fetchProjectFiles(projectId, controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) setFiles(list)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        // Sem estado de erro a lista vazia mentiria ("Nenhum arquivo ainda").
        setFilesError(
          err instanceof Error ? err.message : "Falha ao listar arquivos.",
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingFiles(false)
      })
    return () => controller.abort()
  }, [projectId, filesReloadToken])

  const projectChats = React.useMemo(
    () => chats.filter((c) => c.project_id === projectId),
    [chats, projectId],
  )

  const dirty =
    Boolean(project) &&
    (name !== project!.name ||
      instructions !== (project!.instructions ?? "") ||
      color !== (project!.color ?? PROJECT_COLORS[0]))

  if (!project) {
    return (
      <PageShell>
        {isLoadingProjects ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border py-16 text-center">
            <p className="text-sm font-medium text-foreground">
              Projeto não encontrado.
            </p>
            <Link
              to="/projects"
              className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
            >
              Voltar para Projetos
            </Link>
          </div>
        )}
      </PageShell>
    )
  }

  const handleSave = async () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 120) {
      toast.error("Nome deve ter entre 1 e 120 caracteres.")
      return
    }
    setSaving(true)
    try {
      await updateProject(project.id, {
        name: trimmed,
        instructions,
        color,
      })
      toast.success("Projeto atualizado.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar.")
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteProject = async () => {
    if (deleting) return
    const ok = window.confirm(
      `Excluir o projeto "${project.name}"? As conversas permanecem (sem projeto). Arquivos do projeto serão removidos.`,
    )
    if (!ok) return
    setDeleting(true)
    try {
      await deleteProject(project.id)
      toast.success("Projeto excluído.")
      refreshChats()
      navigate("/projects", { replace: true })
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Falha ao excluir projeto.",
      )
    } finally {
      setDeleting(false)
    }
  }

  const handleUpload = async (fileList: FileList | null) => {
    if (!fileList?.length) return
    const file = fileList[0]!
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error("Arquivo excede 10 MB.")
      return
    }
    setUploading(true)
    try {
      const dataBase64 = await fileToBase64(file)
      const uploaded = await uploadProjectFile(project.id, {
        name: file.name,
        mimeType: file.type || undefined,
        dataBase64,
      })
      setFiles((prev) => [uploaded, ...prev])
      toast.success("Arquivo enviado.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha no upload.")
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const handleDeleteFile = async (file: ProjectFileRecord) => {
    const ok = window.confirm(`Excluir o arquivo "${file.name}"?`)
    if (!ok) return
    try {
      await deleteProjectFile(project.id, file.id)
      setFiles((prev) => prev.filter((f) => f.id !== file.id))
      toast.success("Arquivo excluído.")
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Falha ao excluir arquivo.",
      )
    }
  }

  return (
    <PageShell>
      <PageHeading
        title={
          <span className="flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden
              className="size-3 shrink-0 rounded-full ring-1 ring-black/5"
              style={{ backgroundColor: project.color || "#64748b" }}
            />
            <span className="truncate">{project.name}</span>
          </span>
        }
        description={`Atualizado em ${formatDate(project.updated_at)} · ${projectChats.length} ${
          projectChats.length === 1 ? "conversa" : "conversas"
        }`}
        actions={
          <>
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => newChat(project.id)}
            >
              <Plus className="size-4" />
              Nova conversa
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-10 sm:size-8"
                  aria-label="Ações do projeto"
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  variant="destructive"
                  disabled={deleting}
                  onSelect={() => void handleDeleteProject()}
                >
                  {deleting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  {deleting ? "Excluindo…" : "Excluir projeto"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          <ProjectComposer
            projectName={project.name}
            onSend={(text) => newChatWithMessage(project.id, text)}
          />

          <section>
            <h2 className="text-sm font-medium text-foreground">Conversas</h2>
            <div className="mt-2 overflow-hidden rounded-xl border border-border bg-card">
              {projectChats.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Nenhuma conversa neste projeto ainda.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {projectChats.map((chat) => (
                    <li key={chat.id}>
                      <button
                        type="button"
                        onClick={() => selectChat(chat.id)}
                        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-accent"
                      >
                        <MessageSquare
                          aria-hidden
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-card-foreground">
                          {chat.title || "Sem título"}
                        </span>
                        <span
                          title={formatDateTime(chat.updated_at)}
                          className="shrink-0 text-xs text-muted-foreground"
                        >
                          {formatDate(chat.updated_at)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="text-sm font-medium text-card-foreground">
              Instruções do projeto
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Entram no contexto de toda conversa deste projeto.
            </p>

            <div className="mt-3 space-y-3">
              <div className="space-y-1.5">
                <label
                  htmlFor="project-name"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Nome
                </label>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  className="h-9 text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="project-instructions"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Instruções
                </label>
                <Textarea
                  id="project-instructions"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  rows={6}
                  placeholder="Ex.: responda sempre em PT-BR, cite as fontes dos arquivos anexados…"
                  className="text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Cor
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {PROJECT_COLORS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-label={`Cor ${option}`}
                      aria-pressed={color === option}
                      onClick={() => setColor(option)}
                      className={cn(
                        "size-6 rounded-full ring-1 ring-black/10 transition-transform",
                        color === option &&
                          "ring-2 ring-ring ring-offset-2 ring-offset-card",
                      )}
                      style={{ backgroundColor: option }}
                    />
                  ))}
                </div>
              </div>

              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={!dirty || saving}
                  onClick={() => void handleSave()}
                >
                  {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                  Salvar alterações
                </Button>
              </div>
            </div>
          </section>
        </div>

        <aside className="min-w-0 space-y-4">
          <div className="rounded-xl border border-border bg-muted/40 p-4">
            <span className="flex size-8 items-center justify-center rounded-lg bg-card text-primary">
              <FileText className="size-4" />
            </span>
            <h2 className="mt-2.5 text-sm font-medium text-foreground">
              Adicione contexto ao projeto
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Anexe documentos, planilhas ou trechos de código. O conteúdo dos
              arquivos entra no contexto das conversas deste projeto.
            </p>
          </div>

          <section>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-foreground">Arquivos</h2>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-10 sm:size-8"
                aria-label="Enviar arquivo"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Upload className="size-4" />
                )}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => void handleUpload(e.target.files)}
              />
            </div>

            <div className="mt-2 space-y-2">
              {loadingFiles ? (
                <Skeleton className="h-16 rounded-lg" />
              ) : filesError ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3">
                  <p className="text-xs font-medium text-destructive">
                    Não foi possível listar os arquivos.
                  </p>
                  <p className="mt-1 text-[11px] break-words text-muted-foreground">
                    {filesError}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => setFilesReloadToken((t) => t + 1)}
                  >
                    Tentar de novo
                  </Button>
                </div>
              ) : files.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                  Nenhum arquivo ainda. Até 10 MB por arquivo.
                </p>
              ) : (
                files.map((file) => (
                  <div
                    key={file.id}
                    className="group/file rounded-lg border border-border bg-card p-3"
                  >
                    <div className="flex items-start gap-2">
                      <p className="min-w-0 flex-1 truncate text-xs font-medium text-card-foreground">
                        {file.name}
                      </p>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Excluir ${file.name}`}
                        className="size-10 shrink-0 text-muted-foreground opacity-100 hover:text-destructive sm:size-6 md:opacity-0 md:group-hover/file:opacity-100"
                        onClick={() => void handleDeleteFile(file)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {extensionBadge(file.name)}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {formatBytes(file.size_bytes)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </aside>
      </div>
    </PageShell>
  )
}
