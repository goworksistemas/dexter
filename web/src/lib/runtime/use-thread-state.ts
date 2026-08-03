/**
 * Bridge de estado reativo para a Thread.
 *
 * POR QUE ISTO EXISTE: a versão instalada (@assistant-ui/store@0.3.2 /
 * @assistant-ui/react@0.15.2) tem um bug já corrigido no repositório upstream
 * mas AINDA NÃO publicado no npm (a última versão publicada continua sendo
 * 0.3.2): o client reativo "aui" (usado internamente por ThreadPrimitive.*,
 * ComposerPrimitive.* e MessagePrimitive.*, via `useAuiState`/
 * `useSyncExternalStore`) para de refletir atualizações logo após o primeiro
 * commit. Na prática: `ThreadPrimitive.Empty`/`ThreadPrimitive.Messages`
 * nunca saem do estado inicial e `ComposerPrimitive.Input` nunca mostra o que
 * é digitado, mesmo que o estado real do runtime esteja correto.
 * Commit da correção (ainda não lançado): assistant-ui/assistant-ui@5fdf17e
 * ("fix(store): RenderChildrenWithAccessor missed re-renders after access").
 *
 * CONTORNO: em vez de passar pelos primitivos (que dependem do client "aui"
 * afetado), lemos o estado direto da API imperativa do runtime
 * (`runtime.thread` / `runtime.thread.composer`), que funciona corretamente —
 * confirmado via `runtime.thread.subscribe`/`composer.subscribe` disparando
 * normalmente. `Thread` (thread.tsx) usa estes hooks para renderizar tudo na
 * mão (mensagens, composer, estado vazio) sem os primitivos do assistant-ui.
 *
 * Quando a correção for publicada no npm, dá pra voltar a usar
 * ThreadPrimitive/ComposerPrimitive/MessagePrimitive e apagar este arquivo.
 */
import { useCallback, useRef, useSyncExternalStore } from "react"
import type {
  AssistantRuntime,
  ThreadComposerState,
  ThreadState,
} from "@assistant-ui/react"

/** Estado ao vivo da thread (mensagens, isRunning, etc.), lido via subscribe
 * imperativo — não passa pelo client "aui" quebrado.
 *
 * `getState()` do assistant-ui devolve um objeto novo (congelado) a cada
 * chamada, mesmo sem mudança real. Se `getSnapshot` chamasse `getState()`
 * direto, o React acusaria "the result of getSnapshot should be cached"
 * (duas chamadas seguidas, sem notificação no meio, devolvendo referências
 * diferentes) — por isso o snapshot fica num ref e só é recalculado dentro
 * do callback de notificação do subscribe. */
export function useThreadState(runtime: AssistantRuntime): ThreadState {
  const cacheRef = useRef<ThreadState>(runtime.thread.getState())

  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      runtime.thread.subscribe(() => {
        cacheRef.current = runtime.thread.getState()
        onStoreChange()
      }),
    [runtime]
  )
  const getSnapshot = useCallback(() => cacheRef.current, [])

  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Estado ao vivo do composer (texto, canSend, etc.) — mesma lógica de cache
 * acima, aplicada a `runtime.thread.composer`. */
export function useComposerState(runtime: AssistantRuntime): ThreadComposerState {
  const cacheRef = useRef<ThreadComposerState>(runtime.thread.composer.getState())

  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      runtime.thread.composer.subscribe(() => {
        cacheRef.current = runtime.thread.composer.getState()
        onStoreChange()
      }),
    [runtime]
  )
  const getSnapshot = useCallback(() => cacheRef.current, [])

  return useSyncExternalStore(subscribe, getSnapshot)
}
