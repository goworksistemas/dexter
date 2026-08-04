/**
 * Página /workflows — rotinas que o Dexter executa sozinho no horário e
 * entrega como conversa. Lista, CRUD, execução manual e histórico.
 */
import * as React from "react"
import { Plus, Workflow as WorkflowIcon } from "lucide-react"
import { toast } from "sonner"

import { PageHeading, PageShell } from "@/components/layout/page-shell"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useChats } from "@/lib/chats"
import {
  WORKFLOW_LIMIT,
  WorkflowApiError,
  deleteWorkflow,
  fetchWorkflows,
  runWorkflow,
  updateWorkflow,
  type Workflow,
} from "@/lib/workflows/api"
import { WorkflowCard } from "./workflow-card"
import { WorkflowDialog } from "./workflow-dialog"

/** Intervalo do poll enquanto alguma execução está em andamento. */
const POLL_MS = 10_000

/**
 * POST/PATCH devolvem o workflow SEM `lastRun` (só GET /workflows resume a
 * última execução). Trocar o item pelo retorno cru apagaria o badge da última
 * execução — e, se ela estivesse "running", desligaria o poll.
 */
function mesclar(atual: Workflow, salvo: Workflow): Workflow {
  if (atual.id !== salvo.id) return atual
  return { ...salvo, lastRun: salvo.lastRun ?? atual.lastRun ?? null }
}

export function WorkflowsPage() {
  const { selectChat, refreshChats } = useChats()

  const [workflows, setWorkflows] = React.useState<Workflow[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)

  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<Workflow | null>(null)
  const [togglingId, setTogglingId] = React.useState<string | null>(null)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)
  const [startingIds, setStartingIds] = React.useState<string[]>([])

  const refreshChatsRef = React.useRef(refreshChats)
  React.useEffect(() => {
    refreshChatsRef.current = refreshChats
  }, [refreshChats])

  React.useEffect(() => {
    const controller = new AbortController()
    setIsLoading(true)
    setError(null)
    fetchWorkflows(controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) setWorkflows(list)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        setError(
          err instanceof Error ? err.message : "Falha ao carregar workflows.",
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false)
      })
    return () => controller.abort()
  }, [reloadToken])

  const hasRunning = workflows.some((w) => w.lastRun?.status === "running")
  const tinhaRodandoRef = React.useRef(false)
  React.useEffect(() => {
    tinhaRodandoRef.current = hasRunning
  }, [hasRunning])

  /** Recarrega sem mexer no skeleton — usado pelo poll e após ações. */
  const silentRefresh = React.useCallback(async () => {
    try {
      const list = await fetchWorkflows()
      // Uma execução que terminou criou/atualizou uma conversa: a sidebar
      // precisa conhecê-la para o "Ver resultado" abrir algo de verdade.
      const rodando = list.some((w) => w.lastRun?.status === "running")
      if (tinhaRodandoRef.current && !rodando) refreshChatsRef.current()
      setWorkflows(list)
    } catch {
      /* poll silencioso: falha transitória não derruba a lista já exibida */
    }
  }, [])

  React.useEffect(() => {
    if (!hasRunning) return
    const id = window.setInterval(() => {
      void silentRefresh()
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [hasRunning, silentRefresh])

  const abrirCriacao = () => {
    if (workflows.length >= WORKFLOW_LIMIT) {
      toast.error(
        `Limite de ${WORKFLOW_LIMIT} workflows por usuário. Exclua um antes de criar outro.`,
      )
      return
    }
    setEditing(null)
    setDialogOpen(true)
  }

  const handleToggle = async (workflow: Workflow) => {
    if (togglingId === workflow.id) return
    setTogglingId(workflow.id)
    try {
      const updated = await updateWorkflow(workflow.id, {
        enabled: !workflow.enabled,
      })
      setWorkflows((prev) => prev.map((w) => mesclar(w, updated)))
      toast.success(updated.enabled ? "Workflow ativado." : "Workflow pausado.")
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Falha ao atualizar o workflow.",
      )
    } finally {
      setTogglingId((current) =>
        current === workflow.id ? null : current,
      )
    }
  }

  const handleRunNow = async (workflow: Workflow) => {
    if (startingIds.includes(workflow.id)) return
    setStartingIds((prev) => [...prev, workflow.id])
    try {
      const run = await runWorkflow(workflow.id)
      setWorkflows((prev) =>
        prev.map((w) => (w.id === workflow.id ? { ...w, lastRun: run } : w)),
      )
      toast.success("Execução iniciada — o resultado chega como uma conversa.")
    } catch (err) {
      if (err instanceof WorkflowApiError && err.status === 409) {
        // Já estava rodando: a lista local estava velha, então recarrega.
        toast.error(err.message || "Este workflow já está em execução.")
        void silentRefresh()
      } else {
        toast.error(
          err instanceof Error ? err.message : "Falha ao executar o workflow.",
        )
      }
    } finally {
      setStartingIds((prev) => prev.filter((id) => id !== workflow.id))
    }
  }

  const handleDelete = async (workflow: Workflow) => {
    if (deletingId === workflow.id) return
    const ok = window.confirm(
      `Excluir o workflow "${workflow.name}"? As conversas já geradas por ele permanecem.`,
    )
    if (!ok) return
    setDeletingId(workflow.id)
    try {
      await deleteWorkflow(workflow.id)
      setWorkflows((prev) => prev.filter((w) => w.id !== workflow.id))
      toast.success("Workflow excluído.")
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Falha ao excluir o workflow.",
      )
    } finally {
      setDeletingId((current) => (current === workflow.id ? null : current))
    }
  }

  const handleSaved = (saved: Workflow, mode: "create" | "edit") => {
    setWorkflows((prev) =>
      mode === "create"
        ? [saved, ...prev]
        : prev.map((w) => mesclar(w, saved)),
    )
  }

  return (
    <PageShell>
      <PageHeading
        title="Workflows"
        description="O Dexter executa suas rotinas sozinho e entrega o resultado como uma conversa."
        actions={
          <Button size="sm" className="gap-1.5" onClick={abrirCriacao}>
            <Plus className="size-4" />
            Novo workflow
          </Button>
        }
      />

      <div className="mt-6">
        {isLoading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-36 rounded-xl" />
            ))}
          </div>
        ) : error ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6">
            <p className="text-sm font-medium text-destructive">
              Não foi possível carregar os workflows.
            </p>
            <p className="mt-1 text-xs break-words text-muted-foreground">
              {error}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setReloadToken((t) => t + 1)}
            >
              Tentar novamente
            </Button>
          </div>
        ) : workflows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
            <span className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <WorkflowIcon className="size-5" />
            </span>
            <div>
              <p className="text-sm font-medium text-foreground">
                Nenhum workflow ainda.
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Crie seu primeiro workflow — ex.: resumo diário dos chamados às
                8h.
              </p>
            </div>
            <Button size="sm" className="gap-1.5" onClick={abrirCriacao}>
              <Plus className="size-4" />
              Criar workflow
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {workflows.map((workflow) => (
              <WorkflowCard
                key={workflow.id}
                workflow={workflow}
                toggling={togglingId === workflow.id}
                running={startingIds.includes(workflow.id)}
                deleting={deletingId === workflow.id}
                onToggle={() => void handleToggle(workflow)}
                onRunNow={() => void handleRunNow(workflow)}
                onEdit={() => {
                  setEditing(workflow)
                  setDialogOpen(true)
                }}
                onDelete={() => void handleDelete(workflow)}
                onOpenChat={(chatId) => {
                  // A conversa pode ter nascido do workflow depois do último
                  // fetch da sidebar — garante que ela apareça na lista.
                  refreshChats()
                  selectChat(chatId)
                }}
              />
            ))}
          </div>
        )}
      </div>

      <WorkflowDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) setEditing(null)
        }}
        workflow={editing}
        onSaved={handleSaved}
      />
    </PageShell>
  )
}
