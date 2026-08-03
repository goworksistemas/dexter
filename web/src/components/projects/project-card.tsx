import { MoreHorizontal, Pencil, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatDate, formatDateTime } from "@/lib/format"
import type { ProjectSummary } from "@/lib/projects"

/** Card do grid de /projects: nome, instruções resumidas e rodapé de meta. */
export function ProjectCard({
  project,
  chatCount,
  onOpen,
  onDelete,
}: {
  project: ProjectSummary
  chatCount: number
  onOpen: () => void
  onDelete: () => void
}) {
  return (
    <div className="group/card hover:shadow-elevate-sm relative flex min-h-32 min-w-0 flex-col rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40">
      {/* Alvo de clique do card inteiro, atrás do menu de ações. */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Abrir projeto ${project.name}`}
        className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      />

      <div className="pointer-events-none flex items-start gap-2">
        <span
          aria-hidden
          className="mt-1 size-2.5 shrink-0 rounded-full ring-1 ring-black/5"
          style={{ backgroundColor: project.color || "#64748b" }}
        />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-card-foreground">
          {project.name}
        </h2>
        <span className="w-7 shrink-0" />
      </div>

      <p className="pointer-events-none mt-2 line-clamp-2 min-h-10 text-sm text-muted-foreground">
        {project.instructions.trim() || "Sem instruções."}
      </p>

      <div className="pointer-events-none mt-auto flex items-center gap-2 pt-3 text-xs text-muted-foreground">
        <span title={`Atualizado em ${formatDateTime(project.updated_at)}`}>
          {formatDate(project.updated_at)}
        </span>
        <span aria-hidden>·</span>
        <span>
          {chatCount} {chatCount === 1 ? "conversa" : "conversas"}
        </span>
      </div>

      <div className="absolute top-3 right-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-10 text-muted-foreground opacity-100 sm:size-7 md:opacity-0 md:group-hover/card:opacity-100 md:data-[state=open]:opacity-100"
              aria-label={`Ações do projeto ${project.name}`}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onOpen}>
              <Pencil className="size-4" />
              Abrir e editar
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 className="size-4" />
              Excluir projeto
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
