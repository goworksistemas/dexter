import type { ThreadMessageLike } from "@assistant-ui/react"

/** Cache em memória do histórico — reabrir chat = paint imediato + revalidate. */
export interface HistoryCacheEntry {
  messages: readonly ThreadMessageLike[]
  hasMore: boolean
}

const cache = new Map<string, HistoryCacheEntry>()

export function getCachedHistory(
  chatId: string,
): HistoryCacheEntry | undefined {
  return cache.get(chatId)
}

export function setCachedHistory(
  chatId: string,
  messages: readonly ThreadMessageLike[],
  hasMore: boolean,
): void {
  cache.set(chatId, { messages, hasMore })
}

export function clearCachedHistory(chatId: string): void {
  cache.delete(chatId)
}

/**
 * Junta prefixo antigo do cache com a página mais recente do servidor.
 * Evita perder msgs já carregadas ao rolar pra cima quando revalida o fim.
 */
export function mergeHistoryPage(
  cached: HistoryCacheEntry | undefined,
  page: readonly ThreadMessageLike[],
  pageHasMore: boolean,
): HistoryCacheEntry {
  if (!cached || cached.messages.length === 0) {
    return { messages: page, hasMore: pageHasMore }
  }
  if (page.length === 0) {
    return { messages: cached.messages, hasMore: false }
  }

  const firstPageId = page[0]!.id
  const idx = cached.messages.findIndex((m) => m.id === firstPageId)
  if (idx <= 0) {
    return { messages: page, hasMore: pageHasMore }
  }

  const pageIds = new Set(page.map((m) => m.id))
  const older = cached.messages
    .slice(0, idx)
    .filter((m) => m.id && !pageIds.has(m.id))
  return {
    messages: [...older, ...page],
    hasMore: older.length > 0 ? cached.hasMore : pageHasMore,
  }
}
