import * as React from "react"
import { ArrowUpDown, FolderKanban, Plus, Search, X } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { PageHeading, PageShell } from "@/components/layout/page-shell"
import { ProjectCard } from "@/components/projects/project-card"
import { ProjectDialog } from "@/components/projects/project-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { useChats } from "@/lib/chats"
import { useProjects, type ProjectSummary } from "@/lib/projects"
import { cn } from "@/lib/utils"

type SortKey = "updated" | "created" | "name"

const SORT_LABEL: Record<SortKey, string> = {
  updated: "Última atualização",
  created: "Criação",
  name: "Nome (A–Z)",
}

export function ProjectsPage() {
  const {
    projects,
    isLoadingProjects,
    projectsError,
    deleteProject,
    refreshProjects,
  } = useProjects()
  const { chats, refreshChats } = useChats()
  const navigate = useNavigate()

  const [query, setQuery] = React.useState("")
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [sort, setSort] = React.useState<SortKey>("updated")
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (searchOpen) searchRef.current?.focus()
  }, [searchOpen])

  const chatCountByProject = React.useMemo(() => {
    const map = new Map<string, number>()
    for (const chat of chats) {
      if (!chat.project_id) continue
      map.set(chat.project_id, (map.get(chat.project_id) ?? 0) + 1)
    }
    return map
  }, [chats])

  const visibleProjects = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? projects.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.instructions.toLowerCase().includes(q),
        )
      : [...projects]
    return list.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name, "pt-BR")
      const key = sort === "created" ? "created_at" : "updated_at"
      return a[key] < b[key] ? 1 : -1
    })
  }, [projects, query, sort])

  const handleDelete = async (project: ProjectSummary) => {
    // Sem essa guarda o segundo clique roda contra um projeto já removido.
    if (deletingId === project.id) return
    const ok = window.confirm(
      `Excluir o projeto "${project.name}"? As conversas permanecem (sem projeto). Arquivos do projeto serão removidos.`,
    )
    if (!ok) return
    setDeletingId(project.id)
    try {
      await deleteProject(project.id)
      toast.success("Projeto excluído.")
      refreshChats()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Falha ao excluir projeto.",
      )
    } finally {
      setDeletingId((current) => (current === project.id ? null : current))
    }
  }

  return (
    <PageShell>
      <PageHeading
        title="Projetos"
        actions={
          <>
            {searchOpen ? (
              <div className="relative">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setQuery("")
                      setSearchOpen(false)
                    }
                  }}
                  placeholder="Buscar projeto"
                  aria-label="Buscar projeto"
                  className="h-9 w-56 pr-8 pl-8 text-sm"
                />
                <button
                  type="button"
                  aria-label="Fechar busca"
                  onClick={() => {
                    setQuery("")
                    setSearchOpen(false)
                  }}
                  className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-10 sm:size-8"
                aria-label="Buscar projeto"
                onClick={() => setSearchOpen(true)}
              >
                <Search className="size-4" />
              </Button>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  <ArrowUpDown className="size-3.5" />
                  <span className="hidden sm:inline">Ordenar por:</span>
                  {SORT_LABEL[sort]}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Ordenar por</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => (
                  <DropdownMenuCheckboxItem
                    key={key}
                    checked={sort === key}
                    onCheckedChange={() => setSort(key)}
                  >
                    {SORT_LABEL[key]}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => setDialogOpen(true)}
            >
              <Plus className="size-4" />
              Novo projeto
            </Button>
          </>
        }
      />

      <div className="mt-6">
        {isLoadingProjects ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-32 rounded-xl" />
            ))}
          </div>
        ) : projectsError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6">
            <p className="text-sm font-medium text-destructive">
              Não foi possível carregar os projetos.
            </p>
            <p className="mt-1 text-xs break-words text-muted-foreground">
              {projectsError}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => refreshProjects()}
            >
              Tentar de novo
            </Button>
          </div>
        ) : visibleProjects.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
            <span className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <FolderKanban className="size-5" />
            </span>
            <div>
              <p className="text-sm font-medium text-foreground">
                {query.trim()
                  ? "Nenhum projeto encontrado."
                  : "Nenhum projeto ainda."}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Projetos guardam instruções e arquivos que o Dexter usa em todas
                as conversas do escopo.
              </p>
            </div>
            {query.trim() ? null : (
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => setDialogOpen(true)}
              >
                <Plus className="size-4" />
                Criar projeto
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {visibleProjects.map((project) => {
              const deleting = deletingId === project.id
              return (
                <div
                  key={project.id}
                  aria-busy={deleting || undefined}
                  className={cn(
                    "min-w-0 transition-opacity",
                    deleting && "pointer-events-none opacity-60",
                  )}
                >
                  <ProjectCard
                    project={project}
                    chatCount={chatCountByProject.get(project.id) ?? 0}
                    onOpen={() => navigate(`/projects/${project.id}`)}
                    onDelete={() => void handleDelete(project)}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

      <ProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode="create"
        project={null}
        onCreated={(created) => {
          setDialogOpen(false)
          navigate(`/projects/${created.id}`)
        }}
      />
    </PageShell>
  )
}
