/**
 * Dialog para mover uma conversa para um projeto (ou remover do projeto).
 */
import * as React from "react"
import { FolderInput } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useChats } from "@/lib/chats"
import { useProjects } from "@/lib/projects"
import { cn } from "@/lib/utils"

interface MoveChatDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  chatId: string | null
  chatTitle?: string
  currentProjectId?: string | null
}

export function MoveChatDialog({
  open,
  onOpenChange,
  chatId,
  chatTitle,
  currentProjectId,
}: MoveChatDialogProps) {
  const { projects } = useProjects()
  const { moveChatToProject } = useChats()
  const [selected, setSelected] = React.useState<string | null>(
    currentProjectId ?? null,
  )
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (open) setSelected(currentProjectId ?? null)
  }, [open, currentProjectId])

  const handleConfirm = async () => {
    if (!chatId) return
    if (selected === (currentProjectId ?? null)) {
      onOpenChange(false)
      return
    }
    setSaving(true)
    try {
      await moveChatToProject(chatId, selected)
      toast.success(
        selected ? "Conversa movida para o projeto." : "Conversa removida do projeto.",
      )
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao mover conversa.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderInput className="size-4" />
            Mover para projeto
          </DialogTitle>
          <DialogDescription>
            {chatTitle
              ? `Escolha o projeto para “${chatTitle}”.`
              : "Escolha o projeto de destino."}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-64 space-y-1 overflow-y-auto">
          <button
            type="button"
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent",
              selected === null && "bg-accent font-medium",
            )}
            onClick={() => setSelected(null)}
          >
            Sem projeto
          </button>
          {projects.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              Nenhum projeto criado ainda.
            </p>
          ) : (
            projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent",
                  selected === p.id && "bg-accent font-medium",
                )}
                onClick={() => setSelected(p.id)}
              >
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: p.color || "#64748b" }}
                  aria-hidden
                />
                <span className="truncate">{p.name}</span>
              </button>
            ))
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={saving || !chatId}
          >
            Mover
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
