/**
 * Imagem na conversa: preview, visualizar em lightbox e download.
 */
import { useState } from "react"
import { Download, Expand, X } from "lucide-react"
import { toast } from "sonner"

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

function extFromSrc(src: string): string {
  const m = /^data:image\/([a-z0-9.+-]+);/i.exec(src)
  if (m?.[1]) {
    const t = m[1].toLowerCase()
    if (t === "jpeg") return "jpg"
    return t.replace(/[^a-z0-9]/g, "") || "png"
  }
  try {
    const path = new URL(src, window.location.origin).pathname
    const ext = path.split(".").pop()?.toLowerCase()
    if (ext && /^[a-z0-9]{2,5}$/.test(ext)) return ext
  } catch {
    /* ignore */
  }
  return "png"
}

async function baixarImagem(src: string, basename: string): Promise<void> {
  const filename = `${basename}.${extFromSrc(src)}`
  if (src.startsWith("data:")) {
    const a = document.createElement("a")
    a.href = src
    a.download = filename
    a.rel = "noopener"
    document.body.appendChild(a)
    a.click()
    a.remove()
    return
  }
  const res = await fetch(src)
  if (!res.ok) throw new Error(`Download falhou (HTTP ${res.status})`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.rel = "noopener"
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}

interface MessageImageProps {
  src: string
  alt?: string
  className?: string
  title?: string
}

export function MessageImage({ src, alt, className, title }: MessageImageProps) {
  const [aberto, setAberto] = useState(false)
  const [baixando, setBaixando] = useState(false)
  const label = alt?.trim() || "Imagem gerada"

  const onDownload = async () => {
    setBaixando(true)
    try {
      await baixarImagem(src, "dexter-imagem")
      toast.success("Download iniciado")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha no download")
    } finally {
      setBaixando(false)
    }
  }

  return (
    <>
      <figure className="group/img relative my-2 max-w-md">
        <button
          type="button"
          onClick={() => setAberto(true)}
          className="block w-full overflow-hidden rounded-xl border border-border/60 text-left transition ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Ampliar: ${label}`}
        >
          <img
            src={src}
            alt={label}
            title={title}
            className={cn(
              "max-h-[min(70vh,28rem)] w-full object-contain bg-muted/30",
              className,
            )}
          />
        </button>
        <div className="mt-1.5 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setAberto(true)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Expand className="size-3" />
            Ver
          </button>
          <button
            type="button"
            disabled={baixando}
            onClick={() => void onDownload()}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <Download className="size-3" />
            {baixando ? "Baixando…" : "Download"}
          </button>
        </div>
      </figure>

      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="flex max-h-[95dvh] max-w-[min(96vw,56rem)] flex-col gap-3 overflow-hidden border-border/80 bg-background p-3 sm:max-w-[min(96vw,56rem)]">
          <div className="flex items-center justify-between gap-2 pr-10">
            <DialogTitle className="truncate text-sm font-medium">
              {label}
            </DialogTitle>
            <button
              type="button"
              disabled={baixando}
              onClick={() => void onDownload()}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              <Download className="size-3.5" />
              Download
            </button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg bg-muted/40 p-2">
            <img
              src={src}
              alt={label}
              className="max-h-[min(80dvh,48rem)] max-w-full object-contain"
            />
          </div>
          <button
            type="button"
            className="sr-only"
            onClick={() => setAberto(false)}
          >
            <X className="size-4" />
            Fechar
          </button>
        </DialogContent>
      </Dialog>
    </>
  )
}
