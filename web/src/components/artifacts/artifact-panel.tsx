/**
 * Painel split de artefato: preview (HTML sandbox / Markdown) + editor
 * CodeMirror com realce de sintaxe e formatação via Prettier.
 */
import * as React from "react"
import { AlertTriangle, Code2, ExternalLink, Eye, Save, Sparkles, X } from "lucide-react"
import { toast } from "sonner"

import { HtmlPreview } from "@/components/artifacts/html-preview"
import { Markdown } from "@/components/chat/markdown"
import { Button } from "@/components/ui/button"
import { useMediaQuery } from "@/hooks/use-media-query"
import {
  formatArtifactContent,
  languageForArtifact,
  looksMinified,
  preloadFormatter,
  useArtifacts,
} from "@/lib/artifacts"
import { openArtifactTab, publishArtifactLive } from "@/lib/artifacts/live-channel"
import { cn } from "@/lib/utils"

/**
 * A partir de `lg` o painel divide a tela com o chat; abaixo disso ele vira um
 * overlay fullscreen (o chat não tem largura suficiente para o split).
 */
export const ARTIFACT_SPLIT_QUERY = "(min-width: 64rem)"

/**
 * Largura do split é preferência POR DISPOSITIVO (depende do monitor), então
 * localStorage é o lugar certo — não sincroniza entre máquinas de propósito.
 */
const PANEL_WIDTH_KEY = "dexter.artifactPanel.width"
/** Painel nunca menor que isso (toolbar não quebra). */
const PANEL_MIN_WIDTH = 360
/** Chat mantém pelo menos isso ao arrastar. */
const CHAT_MIN_WIDTH = 420

function readStoredWidth(): number | null {
  try {
    const n = Number(window.localStorage.getItem(PANEL_WIDTH_KEY))
    return Number.isFinite(n) && n >= PANEL_MIN_WIDTH ? n : null
  } catch {
    return null
  }
}

function clampPanelWidth(w: number): number {
  const max = Math.max(PANEL_MIN_WIDTH, window.innerWidth - CHAT_MIN_WIDTH)
  return Math.min(Math.max(Math.round(w), PANEL_MIN_WIDTH), max)
}

/** CodeMirror só entra no bundle quando a aba de código é aberta. */
const loadCodeEditor = () => import("@/components/artifacts/code-editor")
const CodeEditor = React.lazy(() =>
  loadCodeEditor().then((m) => ({ default: m.CodeEditor })),
)

export function ArtifactPanel() {
  const { active, isPanelOpen, closePanel, saveActive, findBySourceKey } = useArtifacts()
  const activeId = active ? findBySourceKey(active.sourceKey)?.id : undefined
  const [tab, setTab] = React.useState<"preview" | "code">("preview")
  const [draft, setDraft] = React.useState("")
  const [title, setTitle] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [formatting, setFormatting] = React.useState(false)
  const isSplit = useMediaQuery(ARTIFACT_SPLIT_QUERY)
  const [panelWidth, setPanelWidth] = React.useState<number | null>(readStoredWidth)
  const [resizing, setResizing] = React.useState(false)

  const openedKeyRef = React.useRef<string | null>(null)
  const panelRef = React.useRef<HTMLElement>(null)
  const lastFocusedRef = React.useRef<HTMLElement | null>(null)

  // Em overlay o painel é um dialog modal: o foco precisa entrar nele ao abrir
  // (senão `aria-modal` mente para o leitor de tela) e voltar ao fechar.
  // A dep é a CHAVE do artefato, não o objeto `active`: ele troca de identidade
  // a cada save (autosave incluso) e o efeito remontaria arrancando o foco do
  // editor ~900ms depois de o usuário parar de digitar.
  const overlayKey = !isSplit && isPanelOpen && active ? active.sourceKey : null
  React.useEffect(() => {
    if (!overlayKey) return
    const previous = document.activeElement
    lastFocusedRef.current = previous instanceof HTMLElement ? previous : null
    panelRef.current?.focus()
    return () => {
      const back = lastFocusedRef.current
      lastFocusedRef.current = null
      if (back?.isConnected) back.focus()
    }
  }, [overlayKey])

  React.useEffect(() => {
    if (resizing || panelWidth == null) return
    try {
      window.localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth))
    } catch {
      /* storage cheio/bloqueado: largura só não persiste */
    }
  }, [panelWidth, resizing])

  const startResize = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isSplit || e.button !== 0) return
      e.preventDefault()
      setResizing(true)
      document.body.style.cursor = "col-resize"
      const onMove = (ev: PointerEvent) => {
        setPanelWidth(clampPanelWidth(window.innerWidth - ev.clientX))
      }
      const onUp = () => {
        setResizing(false)
        document.body.style.removeProperty("cursor")
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", onUp)
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", onUp)
    },
    [isSplit],
  )

  const language = React.useMemo(
    () => (active ? languageForArtifact(active.kind, active.content) : "markdown"),
    [active],
  )

  React.useEffect(() => {
    if (!isPanelOpen) return
    preloadFormatter()
    void loadCodeEditor().catch(() => {
      /* o Suspense recarrega quando a aba de código for aberta */
    })
  }, [isPanelOpen])

  // Em overlay o painel cobre o chat: Esc precisa fechar mesmo sem foco dentro.
  React.useEffect(() => {
    if (!isPanelOpen || isSplit) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [closePanel, isPanelOpen, isSplit])

  // Auto-format ao abrir quando o modelo devolveu conteúdo minificado.
  React.useEffect(() => {
    if (!active) {
      openedKeyRef.current = null
      return
    }
    // Só reseta o rascunho ao trocar de artefato — salvar não descarta a aba
    // atual nem edições em andamento.
    if (openedKeyRef.current === active.sourceKey) return
    openedKeyRef.current = active.sourceKey

    setTitle(active.title)
    setTab("preview")
    setDraft(active.content)

    const lang = languageForArtifact(active.kind, active.content)
    if (!looksMinified(active.content, lang)) return

    let cancelled = false
    void formatArtifactContent(active.content, lang)
      .then((formatted) => {
        if (cancelled || formatted === active.content) return
        setDraft(formatted)
        toast.info("Conteúdo minificado — formatado automaticamente. Salve para manter.")
      })
      .catch(() => {
        /* conteúdo inválido: mantém o original, o botão Formatar reporta o erro */
      })
    return () => {
      cancelled = true
    }
  }, [active])


  // Sync ao vivo para aba dedicada (BroadcastChannel) + autosave no DB.
  React.useEffect(() => {
    if (!isPanelOpen || !active || !activeId) return
    publishArtifactLive({
      artifactId: activeId,
      kind: active.kind,
      title,
      content: draft,
      at: Date.now(),
    })
  }, [active, activeId, draft, isPanelOpen, title])

  React.useEffect(() => {
    if (!isPanelOpen || !active || !activeId) return
    const dirty = draft !== active.content || title !== active.title
    if (!dirty || active.truncated) return
    const t = window.setTimeout(() => {
      void saveActive(draft, title).catch(() => {
        /* toast só no save manual */
      })
    }, 900)
    return () => window.clearTimeout(t)
  }, [active, activeId, draft, isPanelOpen, saveActive, title])

  const handleOpenTab = React.useCallback(async () => {
    if (!active) return
    try {
      let id = activeId
      if (!id) {
        setSaving(true)
        const saved = await saveActive(draft, title)
        id = saved.id
      }
      const win = openArtifactTab(id)
      if (!win) {
        toast.error("O navegador bloqueou a nova aba. Permita pop-ups para o Dexter.")
        return
      }
      publishArtifactLive({
        artifactId: id,
        kind: active.kind,
        title,
        content: draft,
        at: Date.now(),
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível abrir a aba.")
    } finally {
      setSaving(false)
    }
  }, [active, activeId, draft, saveActive, title])

  const handleSave = React.useCallback(async () => {
    setSaving(true)
    try {
      await saveActive(draft, title)
      toast.success("Artefato salvo.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar artefato.")
    } finally {
      setSaving(false)
    }
  }, [draft, saveActive, title])

  const handleFormat = React.useCallback(async () => {
    if (!draft.trim()) return
    setFormatting(true)
    try {
      const formatted = await formatArtifactContent(draft, language)
      if (formatted === draft) {
        toast.info("Já está formatado.")
        return
      }
      setDraft(formatted)
      toast.success("Código formatado.")
    } catch (err) {
      toast.error(
        err instanceof Error
          ? `Não foi possível formatar: ${err.message.split("\n")[0]}`
          : "Não foi possível formatar o código.",
      )
    } finally {
      setFormatting(false)
    }
  }, [draft, language])

  // Shift+Alt+F e Ctrl/Cmd+S funcionam com o painel focado, não só no editor.
  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    // O CodeMirror já tratou (e deu preventDefault) quando o foco está nele.
    if (e.defaultPrevented) return
    if (e.altKey && e.shiftKey && (e.key === "F" || e.key === "f")) {
      e.preventDefault()
      void handleFormat()
      return
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault()
      void handleSave()
      return
    }
    // Em overlay o conteúdo atrás não é inerte: prende o Tab dentro do painel.
    if (!isSplit && e.key === "Tab") {
      const root = panelRef.current
      if (!root) return
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      )
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (!first || !last) return
      const current = document.activeElement
      if (e.shiftKey && (current === first || current === root)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && current === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  if (!isPanelOpen || !active) return null

  const dirty = draft !== active.content || title !== active.title

  return (
    <aside
      ref={panelRef}
      onKeyDown={onPanelKeyDown}
      role={isSplit ? undefined : "dialog"}
      aria-modal={isSplit ? undefined : true}
      aria-label="Painel do artefato"
      tabIndex={isSplit ? undefined : -1}
      style={isSplit && panelWidth != null ? { width: panelWidth } : undefined}
      className={cn(
        "flex min-h-0 flex-col bg-card text-card-foreground outline-none",
        // Abaixo de lg o painel sai do fluxo: o chat mantém a largura inteira.
        // z-30 fica ABAIXO do scrim do drawer (z-40) e do drawer (z-50) — com
        // z-40 o painel empatava com o scrim e, vindo depois no DOM, pintava em
        // cima dele: o drawer não escurecia o painel nem fechava no toque fora.
        "fixed inset-0 z-30 h-dvh w-full",
        "lg:relative lg:z-auto lg:h-full lg:shrink-0 lg:border-l lg:border-border/70",
        // Largura default só até o usuário arrastar (aí vale o style acima).
        panelWidth == null && "lg:w-[min(48%,36rem)] lg:max-w-xl",
      )}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Redimensionar painel do artefato"
        title="Arraste para redimensionar · duplo clique restaura"
        onPointerDown={startResize}
        onDoubleClick={() => setPanelWidth(null)}
        className={cn(
          "absolute inset-y-0 -left-1 z-20 hidden w-2 cursor-col-resize lg:block",
          "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors",
          resizing
            ? "after:w-[3px] after:bg-primary"
            : "hover:after:w-[3px] hover:after:bg-primary/50",
        )}
      />
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-2 py-2 lg:gap-1.5 lg:px-3">
        <div className="relative min-w-0">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full min-w-0 rounded-md bg-transparent py-1.5 pr-11 pl-1.5 text-sm font-medium outline-none placeholder:text-muted-foreground focus-visible:bg-muted/60"
            aria-label="Título do artefato"
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="absolute top-1/2 right-0 size-10 -translate-y-1/2 lg:size-8"
            title="Fechar artefato (Esc)"
            aria-label="Fechar artefato"
            onClick={closePanel}
          >
            <X className="size-5 lg:size-4" />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
            <Button
              type="button"
              size="icon-sm"
              variant={tab === "preview" ? "secondary" : "ghost"}
              className="size-9 lg:size-8"
              aria-label="Preview"
              onClick={() => setTab("preview")}
            >
              <Eye className="size-4 lg:size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant={tab === "code" ? "secondary" : "ghost"}
              className="size-9 lg:size-8"
              aria-label="Código"
              onClick={() => setTab("code")}
            >
              <Code2 className="size-4 lg:size-3.5" />
            </Button>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:ml-auto">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-10 gap-1.5 rounded-lg lg:h-8"
              title="Formatar código (Shift+Alt+F)"
              aria-label="Formatar código"
              disabled={formatting || !draft.trim()}
              onClick={() => void handleFormat()}
            >
              <Sparkles className="size-4 lg:size-3.5" />
              <span className="hidden sm:inline">
                {formatting ? "Formatando…" : "Formatar"}
              </span>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-10 gap-1.5 rounded-lg lg:h-8"
              title="Abrir em aba dedicada (atualiza ao vivo)"
              aria-label="Abrir em aba dedicada"
              disabled={saving}
              onClick={() => void handleOpenTab()}
            >
              <ExternalLink className="size-4 lg:size-3.5" />
              <span className="hidden sm:inline">Nova aba</span>
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-10 gap-1.5 rounded-lg lg:h-8"
              title="Salvar (Ctrl/Cmd+S)"
              disabled={!dirty || saving}
              onClick={() => void handleSave()}
            >
              <Save className="size-4 lg:size-3.5" />
              Salvar
            </Button>
          </div>
        </div>
      </div>

      {active.truncated ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            A resposta do modelo foi cortada antes de fechar este bloco — o conteúdo
            pode estar incompleto. Peça para continuar no chat antes de salvar.
          </span>
        </div>
      ) : null}

      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col p-2 lg:p-3",
          // Iframe do preview engoliria o pointermove no meio do arraste.
          resizing && "pointer-events-none select-none",
        )}
      >
        {tab === "preview" ? (
          active.kind === "html" ? (
            <HtmlPreview html={draft} />
          ) : (
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto rounded-lg border border-border/60 bg-background px-4 py-3">
              <Markdown content={draft} />
            </div>
          )
        ) : (
          <React.Suspense
            fallback={
              <div className="min-h-0 flex-1 rounded-lg border border-border/60 bg-background p-3 font-mono text-[13px] text-muted-foreground">
                Carregando editor…
              </div>
            }
          >
            <CodeEditor
              value={draft}
              language={language}
              onChange={setDraft}
              onSave={() => void handleSave()}
              onFormat={() => void handleFormat()}
              ariaLabel="Editor do artefato"
              className="focus-within:border-ring"
            />
          </React.Suspense>
        )}
      </div>

      <p className="hidden shrink-0 px-3 pb-2.5 text-[11px] text-muted-foreground lg:block">
        Shift+Alt+F formata · Ctrl/Cmd+S salva · Nova aba sincroniza ao vivo
      </p>
    </aside>
  )
}
