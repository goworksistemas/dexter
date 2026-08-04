/**
 * Placeholder estilo “quadro brilhando” enquanto a imagem está sendo gerada.
 */
import { cn } from "@/lib/utils"

interface ImageGenPlaceholderProps {
  className?: string
  label?: string
}

export function ImageGenPlaceholder({
  className,
  label = "Criando imagem",
}: ImageGenPlaceholderProps) {
  return (
    <div
      className={cn("w-full max-w-sm", className)}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <div className="image-gen-frame relative aspect-square w-full overflow-hidden rounded-2xl">
        <div className="image-gen-shimmer absolute inset-0" aria-hidden />
        <div className="image-gen-glow absolute inset-0" aria-hidden />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
          <span className="text-sm font-medium tracking-wide text-foreground/85">
            {label}
          </span>
          <span className="text-xs text-muted-foreground">
            Isso pode levar alguns segundos…
          </span>
        </div>
      </div>
    </div>
  )
}
