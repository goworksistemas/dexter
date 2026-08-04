import * as React from "react"
import { toast } from "sonner"
import {
  BookOpen,
  Info,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  createAdminKbDoc,
  deleteAdminKbDoc,
  fetchAdminKbDocs,
  patchAdminKbDoc,
  type KbCategory,
  type KbDoc,
  type KbDocInput,
} from "@/lib/admin/api"
import { cn } from "@/lib/utils"

const CONTENT_LIMIT = 60000
/** Igual ao check agent_kb_docs_title_len (migration 0020). */
const TITLE_LIMIT = 160

const CATEGORIES: Array<{ value: KbCategory; label: string }> = [
  { value: "empresa", label: "Empresa" },
  { value: "sistemas", label: "Sistemas" },
  { value: "projetos", label: "Projetos" },
  { value: "pessoas", label: "Pessoas" },
  { value: "glossario", label: "Glossário" },
  { value: "geral", label: "Geral" },
]

function categoryLabel(c: KbCategory): string {
  return CATEGORIES.find((x) => x.value === c)?.label ?? c
}

function categoryClass(c: KbCategory): string {
  if (c === "empresa") return "bg-primary/15 text-primary"
  if (c === "sistemas") return "bg-sky-500/15 text-sky-700 dark:text-sky-300"
  if (c === "projetos")
    return "bg-amber-500/15 text-amber-700 dark:text-amber-300"
  if (c === "pessoas")
    return "bg-violet-500/15 text-violet-700 dark:text-violet-300"
  if (c === "glossario")
    return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
  return "bg-muted text-muted-foreground"
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat("pt-BR").format(n)
}

/** Slug estável a partir do título: sem acento, minúsculo, hífens. */
function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

type FormState = {
  title: string
  slug: string
  category: KbCategory
  content: string
  enabled: boolean
  always_load: boolean
  sort: number
}

const EMPTY_FORM: FormState = {
  title: "",
  slug: "",
  category: "geral",
  content: "",
  enabled: true,
  always_load: false,
  sort: 0,
}

function InlineSwitch({
  checked,
  onChange,
  label,
  busy,
  disabled,
}: {
  checked: boolean
  onChange: () => void
  label: string
  busy?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={busy || disabled}
      onClick={onChange}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "inline-flex size-4 items-center justify-center rounded-full bg-background shadow-sm transition-transform",
          checked ? "translate-x-[1.125rem]" : "translate-x-0.5",
        )}
      >
        {busy ? (
          <Loader2 className="size-2.5 animate-spin text-muted-foreground" />
        ) : null}
      </span>
    </button>
  )
}

export function AdminKbPanel() {
  const [docs, setDocs] = React.useState<KbDoc[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState("")
  const [editing, setEditing] = React.useState<KbDoc | null>(null)
  const [formOpen, setFormOpen] = React.useState(false)
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM)
  const [slugTouched, setSlugTouched] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchAdminKbDocs()
      setDocs(data.docs)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar.")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? docs.filter(
          (d) =>
            d.title.toLowerCase().includes(q) ||
            d.slug.toLowerCase().includes(q) ||
            categoryLabel(d.category).toLowerCase().includes(q) ||
            d.content.toLowerCase().includes(q),
        )
      : [...docs]
    return list.sort(
      (a, b) =>
        Number(b.always_load) - Number(a.always_load) ||
        a.sort - b.sort ||
        a.title.localeCompare(b.title, "pt-BR"),
    )
  }, [docs, query])

  const alwaysChars = React.useMemo(
    () =>
      docs.reduce(
        (acc, d) =>
          d.enabled && d.always_load ? acc + d.content.length : acc,
        0,
      ),
    [docs],
  )

  const openCreate = () => {
    setEditing(null)
    setForm({ ...EMPTY_FORM, sort: docs.length })
    setSlugTouched(false)
    setFormOpen(true)
  }

  const openEdit = (doc: KbDoc) => {
    setEditing(doc)
    setForm({
      title: doc.title,
      slug: doc.slug,
      category: doc.category,
      content: doc.content,
      enabled: doc.enabled,
      always_load: doc.always_load,
      sort: doc.sort,
    })
    setSlugTouched(true)
    setFormOpen(true)
  }

  const suggestedSlug = slugTouched ? form.slug : slugify(form.title)

  const toggleField = async (
    doc: KbDoc,
    field: "enabled" | "always_load",
  ) => {
    setBusyId(doc.id)
    try {
      await patchAdminKbDoc(doc.id, { [field]: !doc[field] })
      toast.success("Salvo.")
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao atualizar.")
    } finally {
      setBusyId(null)
    }
  }

  const removeDoc = async (doc: KbDoc) => {
    const ok = window.confirm(
      `Excluir o doc “${doc.title}”? O Dexter perde esse contexto e a ação não tem volta.`,
    )
    if (!ok) return
    setBusyId(doc.id)
    try {
      await deleteAdminKbDoc(doc.id)
      toast.success("Doc excluído.")
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao excluir.")
    } finally {
      setBusyId(null)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const title = form.title.trim()
    const slug = (slugTouched ? form.slug : slugify(form.title)).trim()
    const content = form.content
    if (!title) {
      toast.error("Dê um título ao doc.")
      return
    }
    if (!content.trim()) {
      toast.error("O conteúdo não pode ficar vazio.")
      return
    }
    if (content.length > CONTENT_LIMIT) {
      toast.error(
        `Conteúdo com ${fmtNum(content.length)} caracteres — o limite é ${fmtNum(CONTENT_LIMIT)}.`,
      )
      return
    }
    const payload: KbDocInput = {
      title,
      category: form.category,
      content,
      enabled: form.enabled,
      always_load: form.always_load,
      sort: Number.isFinite(form.sort) ? form.sort : 0,
    }
    if (slug) payload.slug = slug

    setSaving(true)
    try {
      if (editing) {
        await patchAdminKbDoc(editing.id, payload)
        toast.success("Doc atualizado.")
      } else {
        await createAdminKbDoc(payload)
        toast.success("Doc criado.")
      }
      setFormOpen(false)
      setEditing(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-xl border border-border">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Conhecimento</h2>
          <p className="text-xs text-muted-foreground">
            Docs markdown que dão contexto de empresa ao Dexter.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={loading || busyId !== null}
            onClick={() => void load()}
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            Atualizar
          </Button>
          <Button size="sm" className="gap-1.5" onClick={openCreate}>
            <Plus className="size-3.5" />
            Novo doc
          </Button>
        </div>
      </div>

      <div className="flex items-start gap-2 border-b border-border bg-muted/30 px-4 py-2.5">
        <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Docs marcados como <strong className="font-medium">Sempre no contexto</strong>{" "}
          entram em <strong className="font-medium">toda</strong> conversa do Dexter
          (custam tokens em cada mensagem — mantenha-os enxutos); os demais ficam
          disponíveis sob demanda pela tool <code className="font-mono">kb__buscar</code>.
        </p>
      </div>

      {loading ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : error ? (
        <div className="p-4 text-sm">
          <p className="text-destructive">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void load()}
          >
            Tentar de novo
          </Button>
        </div>
      ) : docs.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <BookOpen className="size-7 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">
              Nenhum doc na base de conhecimento
            </p>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              Comece com um doc curto sobre a empresa — o que ela faz, os times e
              os sistemas principais. O Dexter usa isso pra responder sem chute.
            </p>
          </div>
          <Button size="sm" className="gap-1.5" onClick={openCreate}>
            <Plus className="size-3.5" />
            Criar o primeiro doc
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <div className="relative min-w-[12rem] flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filtrar por título, slug ou conteúdo…"
                className="h-8 pl-8 text-sm"
                aria-label="Filtrar docs"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Doc</th>
                  <th className="px-2 py-2.5 font-medium">Categoria</th>
                  <th className="px-2 py-2.5 font-medium">Tamanho</th>
                  <th className="px-2 py-2.5 font-medium">Ativo</th>
                  <th className="px-2 py-2.5 font-medium">Sempre no contexto</th>
                  <th className="px-4 py-2.5 text-right font-medium">Ações</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-8 text-center text-muted-foreground"
                    >
                      Nenhum doc para “{query.trim()}”.
                    </td>
                  </tr>
                ) : (
                  visible.map((d) => {
                    const busy = busyId === d.id
                    return (
                      <tr
                        key={d.id}
                        className={cn(
                          "border-b border-border/60 last:border-0",
                          !d.enabled && "opacity-60",
                        )}
                      >
                        <td className="px-4 py-2.5">
                          <div className="min-w-0">
                            <p className="truncate font-medium">{d.title}</p>
                            <p className="truncate font-mono text-[11px] text-muted-foreground">
                              {d.slug}
                            </p>
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
                              categoryClass(d.category),
                            )}
                          >
                            {categoryLabel(d.category)}
                          </span>
                        </td>
                        <td className="px-2 py-2.5 tabular-nums text-xs text-muted-foreground">
                          {fmtNum(d.content.length)} chars
                        </td>
                        <td className="px-2 py-2.5">
                          <InlineSwitch
                            checked={d.enabled}
                            busy={busy}
                            label={
                              d.enabled
                                ? `Desativar ${d.title}`
                                : `Ativar ${d.title}`
                            }
                            onChange={() => void toggleField(d, "enabled")}
                          />
                        </td>
                        <td className="px-2 py-2.5">
                          <InlineSwitch
                            checked={d.always_load}
                            busy={busy}
                            disabled={!d.enabled}
                            label={
                              d.always_load
                                ? `Tirar ${d.title} do contexto fixo`
                                : `Sempre carregar ${d.title} no contexto`
                            }
                            onChange={() => void toggleField(d, "always_load")}
                          />
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Editar ${d.title}`}
                              title="Editar"
                              disabled={busy}
                              onClick={() => openEdit(d)}
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Excluir ${d.title}`}
                              title="Excluir"
                              disabled={busy}
                              className="text-destructive hover:text-destructive"
                              onClick={() => void removeDoc(d)}
                            >
                              {busy ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="size-3.5" />
                              )}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

          <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
            {visible.length} de {docs.length} doc(s) ·{" "}
            {docs.filter((d) => d.enabled && d.always_load).length} sempre no
            contexto ({fmtNum(alwaysChars)} chars fixos por conversa)
          </p>
        </>
      )}

      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          if (saving) return
          setFormOpen(open)
          if (!open) setEditing(null)
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-2xl sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Editar doc" : "Novo doc"}</DialogTitle>
            <DialogDescription>
              Markdown simples. Escreva direto ao ponto — cada caractere aqui
              pode virar token na conversa.
            </DialogDescription>
          </DialogHeader>

          <form className="space-y-4" onSubmit={(e) => void submit(e)}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="kb-title"
                  className="mb-1.5 block text-xs font-medium text-muted-foreground"
                >
                  Título
                </label>
                <Input
                  id="kb-title"
                  value={form.title}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, title: e.target.value }))
                  }
                  placeholder="Como funciona o faturamento"
                  className="h-9"
                  maxLength={TITLE_LIMIT}
                  required
                />
              </div>
              <div>
                <label
                  htmlFor="kb-slug"
                  className="mb-1.5 block text-xs font-medium text-muted-foreground"
                >
                  Slug
                </label>
                <Input
                  id="kb-slug"
                  value={suggestedSlug}
                  onChange={(e) => {
                    setSlugTouched(true)
                    setForm((f) => ({ ...f, slug: e.target.value }))
                  }}
                  placeholder="como-funciona-o-faturamento"
                  className="h-9 font-mono text-xs"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Sugerido pelo título — editável.
                </p>
              </div>
              <div>
                <label
                  htmlFor="kb-category"
                  className="mb-1.5 block text-xs font-medium text-muted-foreground"
                >
                  Categoria
                </label>
                <select
                  id="kb-category"
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                  value={form.category}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      category: e.target.value as KbCategory,
                    }))
                  }
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="kb-sort"
                  className="mb-1.5 block text-xs font-medium text-muted-foreground"
                >
                  Ordem
                </label>
                <Input
                  id="kb-sort"
                  type="number"
                  value={String(form.sort)}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      sort: Number(e.target.value) || 0,
                    }))
                  }
                  className="h-9 tabular-nums"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Menor aparece primeiro no contexto.
                </p>
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <label
                  htmlFor="kb-content"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Conteúdo (markdown)
                </label>
                <span
                  className={cn(
                    "text-[11px] tabular-nums",
                    form.content.length > CONTENT_LIMIT
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {fmtNum(form.content.length)} / {fmtNum(CONTENT_LIMIT)}
                </span>
              </div>
              <Textarea
                id="kb-content"
                value={form.content}
                onChange={(e) =>
                  setForm((f) => ({ ...f, content: e.target.value }))
                }
                maxLength={CONTENT_LIMIT}
                aria-invalid={form.content.length > CONTENT_LIMIT}
                placeholder={"# Faturamento\n\n- Ciclo fecha no dia 25…"}
                className="scroll-thin field-sizing-fixed h-64 resize-y font-mono text-xs leading-relaxed"
                required
              />
            </div>

            <div className="flex flex-wrap items-center gap-5">
              <div className="flex items-center gap-2">
                <InlineSwitch
                  checked={form.enabled}
                  label="Doc ativo"
                  onChange={() =>
                    setForm((f) => ({ ...f, enabled: !f.enabled }))
                  }
                />
                <span className="text-sm">Ativo</span>
              </div>
              <div className="flex items-center gap-2">
                <InlineSwitch
                  checked={form.always_load}
                  label="Sempre carregar no contexto"
                  onChange={() =>
                    setForm((f) => ({ ...f, always_load: !f.always_load }))
                  }
                />
                <span className="text-sm">Sempre no contexto</span>
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => {
                  setFormOpen(false)
                  setEditing(null)
                }}
              >
                Cancelar
              </Button>
              <Button type="submit" size="sm" className="gap-1.5" disabled={saving}>
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {editing ? "Salvar" : "Criar doc"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}
