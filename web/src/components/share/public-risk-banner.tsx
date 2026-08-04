import { AlertTriangle } from "lucide-react"

import { cn } from "@/lib/utils"

const TEXT =
  "Este conteúdo pode incluir dados internos da empresa. A GoWork não recomenda compartilhar links públicos com informações sensíveis. Trate como confidencial."

/** Banner fixo nas páginas públicas /s/c e /s/a. */
export function PublicRiskBanner({ className }: { className?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2.5 text-sm text-amber-950 dark:text-amber-50 sm:px-6",
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" />
      <p className="leading-snug">
        <span className="font-semibold">Aviso: dados internos. </span>
        {TEXT}
      </p>
    </div>
  )
}
