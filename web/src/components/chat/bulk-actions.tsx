/**
 * Ações em massa da lista de conversas: barra contextual (arquivar,
 * desarquivar, mover para projeto, excluir, cancelar seleção) + dialogs de
 * confirmação. Usada pela sidebar (variante compacta) e pela página /chats.
 *
 * Excluir é sempre soft delete no servidor — o dialog deixa explícito que a
 * conversa some da lista mas o histórico de custo é preservado.
 */
import * as React from "react"
import {
  Archive,
  ArchiveRestore,
  CheckCheck,
  FolderInput,
  Loader2,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useChats, type BulkChatAction, type ChatSummary } from "@/lib/chats"
import { useProjects } from "@/lib/projects"
import { cn } from "@/lib/utils"

function plural(n: number, singular: string, plural: string): string {
  return n === 1 ? `1 ${singular}` : `${n} ${plural}`
}

function mensagemSucesso(
  action: BulkChatAction,
  afetadas: number,
  projectId: string | null,
): string {
  const conversas = plural(afetadas, "conversa", "conversas")
  switch (action) {
    case "archive":
      return afetadas === 1
        ? "1 conversa arquivada."
        : `${afetadas} conversas arquivadas.`
    case "unarchive":
      return afetadas === 1
        ? "1 conversa desarquivada."
        : `${afetadas} conversas desarquivadas.`
    case "delete":
      return `${plural(afetadas, "conversa excluída", "conversas excluídas")}. O histórico de custo foi preservado.`
    case "move":
      return projectId
        ? `${conversas} movida${afetadas === 1 ? "" : "s"} para o projeto.`
        : `${conversas} removida${afetadas === 1 ? "" : "s"} do projeto.`
  }
}

/** Dialog de mover VÁRIAS conversas — picker dos projetos existentes. */
function BulkMoveDialog({
  open,
  onOpenChange,
  count,
  saving,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  count: number
  saving: boolean
  onConfirm: (projectId: string | null) => void
}) {
  const { projects } = useProjects()
  const [selected, setSelected] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (open) setSelected(null)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderInput className="size-4" />
            Mover para projeto
          </DialogTitle>
          <DialogDescription>
            Escolha o destino de {plural(count, "conversa", "conversas")}{" "}
            selecionada{count === 1 ? "" : "s"}.
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
            onClick={() => onConfirm(selected)}
            disabled={saving}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Mover
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Confirmação explícita de exclusão em massa (soft delete no servidor). */
function BulkDeleteDialog({
  open,
  onOpenChange,
  count,
  saving,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  count: number
  saving: boolean
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="size-4 text-destructive" />
            Excluir {plural(count, "conversa", "conversas")}?
          </DialogTitle>
          <DialogDescription>
            {count === 1 ? "A conversa some" : "As conversas somem"} da sua
            lista e não {count === 1 ? "pode" : "podem"} ser reaberta
            {count === 1 ? "" : "s"}. O histórico de custo e consumo de tokens
            é preservado para a administração. Esta ação não pode ser desfeita.
          </DialogDescription>
        </DialogHeader>

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
            variant="destructive"
            onClick={onConfirm}
            disabled={saving}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Excluir {count === 1 ? "" : `${count} `}
            {count === 1 ? "conversa" : "conversas"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Barra contextual da seleção. Aparece quando há conversas selecionadas;
 * `compact` reduz para ícones (sidebar). Mostra Arquivar/Desarquivar conforme
 * o que está selecionado (misto exibe os dois).
 */
export function ChatBulkActionsBar({
  selecionadas,
  totalVisiveis,
  onSelecionarTodas,
  onLimpar,
  compact = false,
  className,
}: {
  /** Conversas atualmente selecionadas (já resolvidas da lista). */
  selecionadas: ChatSummary[]
  /** Quantas conversas estão visíveis (para "Selecionar todas"). */
  totalVisiveis: number
  onSelecionarTodas: () => void
  onLimpar: () => void
  compact?: boolean
  className?: string
}) {
  const { bulkChats } = useChats()
  const [busy, setBusy] = React.useState<BulkChatAction | null>(null)
  const [moveOpen, setMoveOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  const count = selecionadas.length
  const temAtiva = selecionadas.some((c) => !c.archived_at)
  const temArquivada = selecionadas.some((c) => Boolean(c.archived_at))

  const executar = React.useCallback(
    async (action: BulkChatAction, projectId?: string | null) => {
      if (count === 0 || busy) return
      setBusy(action)
      try {
        const afetadas = await bulkChats(
          action,
          selecionadas.map((c) => c.id),
          projectId,
        )
        toast.success(mensagemSucesso(action, afetadas, projectId ?? null))
        setMoveOpen(false)
        setDeleteOpen(false)
        onLimpar()
      } catch (err) {
        // O contexto já fez rollback da lista — aqui só avisa.
        toast.error(
          err instanceof Error ? err.message : "Falha na ação em massa.",
        )
      } finally {
        setBusy(null)
      }
    },
    [bulkChats, busy, count, onLimpar, selecionadas],
  )

  if (count === 0) return null

  const label = (texto: string) =>
    compact ? <span className="sr-only">{texto}</span> : texto

  return (
    <>
      <div
        role="toolbar"
        aria-label="Ações em massa nas conversas selecionadas"
        className={cn(
          "flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1.5 shadow-sm",
          compact ? "flex-wrap" : "flex-wrap sm:flex-nowrap",
          className,
        )}
      >
        <span
          className={cn(
            "shrink-0 px-1 font-medium text-card-foreground",
            compact ? "text-xs" : "text-sm",
          )}
        >
          {plural(count, "selecionada", "selecionadas")}
        </span>

        {count < totalVisiveis ? (
          <Button
            type="button"
            variant="ghost"
            size={compact ? "icon-sm" : "sm"}
            className="shrink-0 gap-1.5 text-muted-foreground"
            onClick={onSelecionarTodas}
            disabled={busy !== null}
            title="Selecionar todas as conversas visíveis"
          >
            <CheckCheck className="size-4" />
            {label("Selecionar todas")}
          </Button>
        ) : null}

        <span className="min-w-0 flex-1" aria-hidden />

        {temAtiva ? (
          <Button
            type="button"
            variant="ghost"
            size={compact ? "icon-sm" : "sm"}
            className="shrink-0 gap-1.5"
            onClick={() => void executar("archive")}
            disabled={busy !== null}
            title="Arquivar selecionadas"
          >
            {busy === "archive" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Archive className="size-4" />
            )}
            {label("Arquivar")}
          </Button>
        ) : null}

        {temArquivada ? (
          <Button
            type="button"
            variant="ghost"
            size={compact ? "icon-sm" : "sm"}
            className="shrink-0 gap-1.5"
            onClick={() => void executar("unarchive")}
            disabled={busy !== null}
            title="Desarquivar selecionadas"
          >
            {busy === "unarchive" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArchiveRestore className="size-4" />
            )}
            {label("Desarquivar")}
          </Button>
        ) : null}

        <Button
          type="button"
          variant="ghost"
          size={compact ? "icon-sm" : "sm"}
          className="shrink-0 gap-1.5"
          onClick={() => setMoveOpen(true)}
          disabled={busy !== null}
          title="Mover selecionadas para projeto"
        >
          {busy === "move" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <FolderInput className="size-4" />
          )}
          {label("Mover")}
        </Button>

        <Button
          type="button"
          variant="ghost"
          size={compact ? "icon-sm" : "sm"}
          className="shrink-0 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setDeleteOpen(true)}
          disabled={busy !== null}
          title="Excluir selecionadas"
        >
          {busy === "delete" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Trash2 className="size-4" />
          )}
          {label("Excluir")}
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground"
          onClick={onLimpar}
          disabled={busy !== null}
          aria-label="Cancelar seleção"
          title="Cancelar seleção"
        >
          <X className="size-4" />
        </Button>
      </div>

      <BulkMoveDialog
        open={moveOpen}
        onOpenChange={(open) => {
          if (!busy) setMoveOpen(open)
        }}
        count={count}
        saving={busy === "move"}
        onConfirm={(projectId) => void executar("move", projectId)}
      />
      <BulkDeleteDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!busy) setDeleteOpen(open)
        }}
        count={count}
        saving={busy === "delete"}
        onConfirm={() => void executar("delete")}
      />
    </>
  )
}

/**
 * Checkbox de seleção de uma linha da lista de conversas — botão com
 * aparência de checkbox (o app não tem componente checkbox e o clique não
 * pode disparar a navegação da linha).
 */
export function ChatSelectCheckbox({
  checked,
  title,
  onToggle,
  className,
}: {
  checked: boolean
  title: string
  onToggle: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={
        checked
          ? `Remover "${title}" da seleção`
          : `Selecionar conversa "${title}"`
      }
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-muted-foreground/50 bg-transparent hover:border-foreground/70",
        className,
      )}
    >
      {checked ? (
        <svg
          viewBox="0 0 12 12"
          className="size-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M2 6.5 4.5 9 10 3.5" />
        </svg>
      ) : null}
    </button>
  )
}
