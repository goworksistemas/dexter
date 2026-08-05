import * as React from "react"
import { toast } from "sonner"

import { useChats } from "./chats-context"
import type { ChatSummary } from "./types"

export type ChatMenuState = {
  chatId: string
  title: string
  projectId: string | null
  x: number
  y: number
}

export type MoveDialogState = {
  open: boolean
  chatId: string | null
  title: string
  projectId: string | null
}

const EMPTY_MOVE: MoveDialogState = {
  open: false,
  chatId: null,
  title: "",
  projectId: null,
}

/** Estado e handlers compartilhados para renomear, mover e excluir conversas. */
export function useChatActions() {
  const { chats, renameChat, deleteChat } = useChats()
  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  const [renameValue, setRenameValue] = React.useState("")
  const [chatMenu, setChatMenu] = React.useState<ChatMenuState | null>(null)
  const [moveDialog, setMoveDialog] =
    React.useState<MoveDialogState>(EMPTY_MOVE)
  const [shareDialog, setShareDialog] = React.useState<{
    open: boolean
    chatId: string | null
  }>({ open: false, chatId: null })
  const renameInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (renamingId) renameInputRef.current?.focus()
  }, [renamingId])

  const commitRename = React.useCallback(
    async (id: string) => {
      const title = renameValue.trim()
      setRenamingId(null)
      if (!title || title.length > 120) {
        toast.error("Título deve ter entre 1 e 120 caracteres.")
        return
      }
      const atual = chats.find((c) => c.id === id)?.title
      if (title === atual) return
      try {
        await renameChat(id, title)
        toast.success("Conversa renomeada.")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Falha ao renomear.")
      }
    },
    [chats, renameChat, renameValue],
  )

  const handleDeleteChat = React.useCallback(
    async (id: string, title: string) => {
      const ok = window.confirm(
        `Excluir a conversa "${title || "sem título"}"? Ela some da sua lista (o histórico de custo é preservado). Esta ação não pode ser desfeita.`,
      )
      if (!ok) return
      try {
        await deleteChat(id)
        toast.success("Conversa excluída.")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Falha ao excluir.")
      }
    },
    [deleteChat],
  )

  const openChatMenu = React.useCallback(
    (e: React.MouseEvent, chat: ChatSummary) => {
      e.preventDefault()
      e.stopPropagation()
      setChatMenu({
        chatId: chat.id,
        title: chat.title || "Sem título",
        projectId: chat.project_id,
        x: e.clientX,
        y: e.clientY,
      })
    },
    [],
  )

  const startRename = React.useCallback((chatId: string, title: string) => {
    setRenamingId(chatId)
    setRenameValue(title)
  }, [])

  const openMoveDialog = React.useCallback(
    (chatId: string, title: string, projectId: string | null) => {
      setMoveDialog({ open: true, chatId, title, projectId })
    },
    [],
  )

  const cancelRename = React.useCallback(() => setRenamingId(null), [])

  const closeChatMenu = React.useCallback(() => setChatMenu(null), [])

  const openShareDialog = React.useCallback((chatId: string) => {
    setShareDialog({ open: true, chatId })
  }, [])

  const actionsForChat = React.useCallback(
    (chatId: string, title: string, projectId: string | null) => ({
      onRename: () => startRename(chatId, title),
      onMove: () => openMoveDialog(chatId, title, projectId),
      onShare: () => openShareDialog(chatId),
      onDelete: () => void handleDeleteChat(chatId, title),
    }),
    [handleDeleteChat, openMoveDialog, openShareDialog, startRename],
  )

  return {
    renamingId,
    renameValue,
    setRenameValue,
    renameInputRef,
    commitRename,
    cancelRename,
    chatMenu,
    closeChatMenu,
    openChatMenu,
    startRename,
    openMoveDialog,
    handleDeleteChat,
    moveDialog,
    setMoveDialog,
    shareDialog,
    setShareDialog,
    openShareDialog,
    actionsForChat,
  }
}
