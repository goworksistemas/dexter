/**
 * Estado dos anexos do composer: os "pendentes" (escolhidos no <input>, ainda
 * não enviados) e os "enviados" (já anexados a uma mensagem do usuário, só
 * pra a bolha conseguir mostrar as miniaturas depois do envio).
 *
 * Mesmo padrão de "latest ref" usado em `use-dexter-runtime.tsx` pra
 * threadId/model: `usePendingAttachments` devolve, junto do estado React
 * (pra renderizar os chips), um `ref` sempre sincronizado — é isso que o
 * ChatModelAdapter lê de forma síncrona dentro de `run()`, sem precisar
 * esperar um re-render.
 */
import { useCallback, useRef, useState } from "react"
import { toast } from "sonner"

import type { ChatAttachment } from "@/lib/agentcore/contract"

/** Anexo pendente: um `ChatAttachment` + um `id` local (key do chip / alvo
 * do botão remover). O `id` não faz parte do contrato enviado ao backend. */
export interface PendingAttachment extends ChatAttachment {
  id: string
}

export const MAX_ANEXOS = 5
export const MAX_BYTES_POR_ANEXO = 5 * 1024 * 1024 // ~5MB

const TIPOS_ACEITOS: Record<string, ChatAttachment["type"]> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "application/pdf": "document",
}

/** Aceito pelo <input accept=...> do composer. */
export const ACCEPT_ANEXOS = Object.keys(TIPOS_ACEITOS).join(",")

export interface PendingAttachmentsController {
  /** Anexos pendentes — estado reativo, usado pra renderizar os chips. */
  attachments: PendingAttachment[]
  /** Ref sempre sincronizado com `attachments`. Lido pelo adapter em run(). */
  ref: React.RefObject<ChatAttachment[]>
  /** Lê os arquivos escolhidos no input, valida (tipo/tamanho/quantidade) e
   * adiciona aos pendentes. Avisa via toast os que forem rejeitados. */
  addFiles: (files: FileList | File[]) => Promise<void>
  /** Remove um anexo pendente pelo id (botão X do chip). */
  remove: (id: string) => void
  /** Limpa todos os pendentes (chamado pelo adapter logo após montar o
   * ChatRequest com eles). */
  clear: () => void
}

/** Lê um File como base64 puro (sem o prefixo `data:...;base64,`). */
function lerComoBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const resultado = reader.result
      if (typeof resultado !== "string") {
        reject(new Error(`Falha ao ler "${file.name}"`))
        return
      }
      const virgula = resultado.indexOf(",")
      resolve(virgula === -1 ? resultado : resultado.slice(virgula + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error(`Falha ao ler "${file.name}"`))
    reader.readAsDataURL(file)
  })
}

export function usePendingAttachments(): PendingAttachmentsController {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  // Fonte da verdade lida pelo adapter — mesma referência do início ao fim,
  // só o conteúdo muda (é assim que threadIdRef/modelIdRef funcionam também).
  const ref = useRef<PendingAttachment[]>([])

  const sync = useCallback((next: PendingAttachment[]) => {
    ref.current = next
    setAttachments(next)
  }, [])

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const lista = Array.from(files)
      if (lista.length === 0) return

      const atual = ref.current
      const vagas = MAX_ANEXOS - atual.length
      if (vagas <= 0) {
        toast.warning(`Máximo de ${MAX_ANEXOS} anexos por mensagem.`)
        return
      }

      const aceitos: PendingAttachment[] = []
      let tipoInvalido = 0
      let tamanhoInvalido = 0
      let excedentes = 0

      for (const file of lista) {
        if (aceitos.length >= vagas) {
          excedentes++
          continue
        }
        const tipo = TIPOS_ACEITOS[file.type]
        if (!tipo) {
          tipoInvalido++
          continue
        }
        if (file.size > MAX_BYTES_POR_ANEXO) {
          tamanhoInvalido++
          continue
        }
        try {
          const dataBase64 = await lerComoBase64(file)
          aceitos.push({
            id: crypto.randomUUID(),
            type: tipo,
            name: file.name,
            mediaType: file.type,
            dataBase64,
          })
        } catch {
          tamanhoInvalido++
        }
      }

      if (tipoInvalido > 0) {
        toast.warning(
          tipoInvalido === 1
            ? "1 arquivo ignorado: tipo não suportado (use imagem ou PDF)."
            : `${tipoInvalido} arquivos ignorados: tipo não suportado (use imagem ou PDF).`
        )
      }
      if (tamanhoInvalido > 0) {
        const limiteMb = MAX_BYTES_POR_ANEXO / (1024 * 1024)
        toast.warning(
          tamanhoInvalido === 1
            ? `1 arquivo ignorado: acima de ${limiteMb}MB.`
            : `${tamanhoInvalido} arquivos ignorados: acima de ${limiteMb}MB.`
        )
      }
      if (excedentes > 0) {
        toast.warning(`Só cabem mais ${vagas} anexo(s) nesta mensagem (máximo ${MAX_ANEXOS}).`)
      }

      if (aceitos.length > 0) sync([...atual, ...aceitos])
    },
    [sync]
  )

  const remove = useCallback(
    (id: string) => sync(ref.current.filter((anexo) => anexo.id !== id)),
    [sync]
  )

  const clear = useCallback(() => sync([]), [sync])

  return { attachments, ref, addFiles, remove, clear }
}

/** Anexos já enviados, indexados por id da mensagem do usuário — só pra a
 * bolha renderizar as miniaturas do que foi mandado (ver `MessageBubble` em
 * `thread.tsx`). Preenchido pelo adapter no momento em que ele monta o
 * ChatRequest (mesmo instante em que lê e limpa os pendentes). */
export interface SentAttachmentsController {
  porMensagem: Record<string, ChatAttachment[]>
  /** Chamado pelo adapter (via ref) logo após anexar os pendentes à última
   * mensagem do usuário. */
  registrar: (messageId: string, attachments: ChatAttachment[]) => void
}

export function useSentAttachments(): SentAttachmentsController {
  const [porMensagem, setPorMensagem] = useState<Record<string, ChatAttachment[]>>({})

  const registrar = useCallback((messageId: string, attachments: ChatAttachment[]) => {
    setPorMensagem((prev) => ({ ...prev, [messageId]: attachments }))
  }, [])

  return { porMensagem, registrar }
}
