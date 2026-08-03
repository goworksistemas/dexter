/**
 * Dialog de criar/editar projeto: nome, instruções, cor e arquivos.
 */
import * as React from "react"
import { FileText, Loader2, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  deleteProjectFile,
  fetchProjectFiles,
  fileToBase64,
  PROJECT_COLORS,
  uploadProjectFile,
  useProjects,
  type ProjectFileRecord,
  type ProjectSummary,
} from "@/lib/projects"
import { cn } from "@/lib/utils"

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export type ProjectDialogMode = "create" | "edit"

interface ProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: ProjectDialogMode
  project?: ProjectSummary | null
  /** Após criar com sucesso — recebe o projeto criado. */
  onCreated?: (project: ProjectSummary) => void
}

export function ProjectDialog({
  open,
  onOpenChange,
  mode,
  project,
  onCreated,
}: ProjectDialogProps) {
  const { createProject, updateProject } = useProjects()
  const [name, setName] = React.useState("")
  const [instructions, setInstructions] = React.useState("")
  const [color, setColor] = React.useState<string | null>(PROJECT_COLORS[0])
  const [saving, setSaving] = React.useState(false)
  const [files, setFiles] = React.useState<ProjectFileRecord[]>([])
  const [loadingFiles, setLoadingFiles] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!open) return
    if (mode === "edit" && project) {
      setName(project.name)
      setInstructions(project.instructions ?? "")
      setColor(project.color ?? PROJECT_COLORS[0])
    } else {
      setName("")
      setInstructions("")
      setColor(PROJECT_COLORS[0])
      setFiles([])
    }
  }, [open, mode, project])

  const loadFiles = React.useCallback(async (projectId: string, signal?: AbortSignal) => {
    setLoadingFiles(true)
    try {
      const list = await fetchProjectFiles(projectId, signal)
      if (!signal?.aborted) setFiles(list)
    } catch (err) {
      if (signal?.aborted) return
      toast.error(err instanceof Error ? err.message : "Falha ao listar arquivos.")
    } finally {
      if (!signal?.aborted) setLoadingFiles(false)
    }
  }, [])

  React.useEffect(() => {
    if (!open || mode !== "edit" || !project) return
    const controller = new AbortController()
    void loadFiles(project.id, controller.signal)
    return () => controller.abort()
  }, [open, mode, project, loadFiles])

  const handleSave = async () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 120) {
      toast.error("Nome deve ter entre 1 e 120 caracteres.")
      return
    }
    setSaving(true)
    try {
      if (mode === "create") {
        const created = await createProject({
          name: trimmed,
          instructions,
          color,
        })
        toast.success("Projeto criado.")
        // onCreated pode reabrir em modo edição (arquivos); senão fecha.
        if (onCreated) {
          onCreated(created)
        } else {
          onOpenChange(false)
        }
      } else if (project) {
        await updateProject(project.id, {
          name: trimmed,
          instructions,
          color,
        })
        toast.success("Projeto atualizado.")
        onOpenChange(false)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar projeto.")
    } finally {
      setSaving(false)
    }
  }

  const handleUpload = async (fileList: FileList | null) => {
    if (!project || !fileList?.length) return
    const file = fileList[0]!
    if (file.size > 10 * 1024 * 1024) {
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
    if (!project) return
    const ok = window.confirm(`Excluir o arquivo "${file.name}"?`)
    if (!ok) return
    try {
      await deleteProjectFile(project.id, file.id)
      setFiles((prev) => prev.filter((f) => f.id !== file.id))
      toast.success("Arquivo excluído.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao excluir arquivo.")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Novo projeto" : "Editar projeto"}
          </DialogTitle>
          <DialogDescription>
            Instruções e arquivos deste projeto entram no contexto de todas as
            conversas dele.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="project-name" className="text-sm font-medium">
              Nome
            </label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Onboarding comercial"
              maxLength={120}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="project-instructions" className="text-sm font-medium">
              Instruções do projeto
            </label>
            <Textarea
              id="project-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Como o Dexter deve se comportar neste projeto: tom, regras, contexto de negócio…"
              className="min-h-36"
            />
          </div>

          <div className="space-y-1.5">
            <span className="text-sm font-medium">Cor</span>
            <div className="flex flex-wrap gap-2">
              {PROJECT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Cor ${c}`}
                  aria-pressed={color === c}
                  className={cn(
                    "size-7 rounded-full border-2 transition-transform",
                    color === c
                      ? "scale-110 border-foreground"
                      : "border-transparent opacity-80 hover:opacity-100",
                  )}
                  style={{ backgroundColor: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>

          {mode === "edit" && project ? (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">Arquivos</span>
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => void handleUpload(e.target.files)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploading ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Upload className="size-3.5" />
                    )}
                    Enviar arquivo
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Até 10 MB. Textos (.txt, .md, .csv, .json…) entram no contexto do
                agente; demais tipos ficam listados no prompt.
              </p>
              {loadingFiles ? (
                <p className="text-sm text-muted-foreground">Carregando arquivos…</p>
              ) : files.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhum arquivo ainda.</p>
              ) : (
                <ul className="space-y-1.5">
                  {files.map((f) => (
                    <li
                      key={f.id}
                      className="flex items-center gap-2 rounded-md border border-border/70 px-2 py-1.5"
                    >
                      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{f.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatBytes(f.size_bytes)}
                          {f.mime_type ? ` · ${f.mime_type}` : ""}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Excluir ${f.name}`}
                        onClick={() => void handleDeleteFile(f)}
                      >
                        <Trash2 className="size-3.5 text-destructive" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancelar
            </Button>
            <Button type="button" onClick={() => void handleSave()} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {mode === "create" ? "Criar projeto" : "Salvar"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
