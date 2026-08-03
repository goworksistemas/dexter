// Barrel export do módulo de conversas: estado real (sem mock) consumido
// pela sidebar, header e chat.
export {
  ChatsProvider,
  useActiveChatProjectId,
  useChats,
} from "./chats-context"
export {
  ChatRunsProvider,
  useChatRun,
  useChatRunProgress,
  useChatRuns,
  useIsChatRunning,
} from "./chat-runs-context"
export { useChatStepsHistory } from "./use-chat-steps"
export { formatarDuracao } from "./run-steps"
export type { RunProgress, RunStep, RunStepStatus } from "./run-steps"
export type { ChatMessageRecord, ChatSummary } from "./types"
