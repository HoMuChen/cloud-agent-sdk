import type { LanguageModel } from 'ai'

// === Token Usage ===
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

// === Agent Events (discriminated union) ===
export type AgentEvent =
  | TextDeltaEvent
  | ToolCallStartEvent
  | ToolCallCompleteEvent
  | CompactEvent
  | StatusEvent
  | AgentErrorEvent
  | ResultEvent

export interface TextDeltaEvent {
  type: 'text-delta'
  text: string
}

export interface ToolCallStartEvent {
  type: 'tool-call-start'
  toolName: string
  toolCallId: string
}

export interface ToolCallCompleteEvent {
  type: 'tool-call-complete'
  toolName: string
  toolCallId: string
  input: unknown
  output: unknown
}

export interface CompactEvent {
  type: 'compact'
  freedTokens: number
  summary: string
  compactedCount: number
}

export interface StatusEvent {
  type: 'status'
  message: string
}

export interface AgentErrorEvent {
  type: 'error'
  error: Error
  recoverable: boolean
}

export interface ResultEvent {
  type: 'result'
  text: string
  usage: TokenUsage
  durationMs: number
  stoppedByTool?: string
}

// === Context Provider ===
export interface ContextProvider {
  name: string
  resolve(ctx: ContextResolveParams): Promise<ContextBlock | null>
}

export interface ContextBlock {
  content: string
  placement: 'system' | 'user-prefix'
}

export interface ContextResolveParams {
  conversationId: string
  turnIndex: number
  userId?: string
  metadata?: Record<string, unknown>
}

// === Conversation Store ===
export interface ConversationStore {
  append(conversationId: string, messages: StoreMessage[]): Promise<void>
  loadAll(conversationId: string): Promise<StoreMessage[] | null>
  loadActive(conversationId: string): Promise<StoreMessage[] | null>
  list?(userId: string, options?: { limit?: number; cursor?: string }): Promise<ConversationListResult>
}

export interface ConversationListResult {
  conversations: ConversationSummary[]
  nextCursor?: string
}

export interface ConversationSummary {
  id: string
  title?: string
  lastMessageAt: Date
  messageCount: number
  compactionCount: number
}

export interface CompactBoundaryMessage {
  role: 'system'
  type: 'compact_boundary'
  content: string
  metadata: {
    trigger: 'auto' | 'manual'
    compactedMessageCount: number
    preCompactTokenCount: number
    postCompactTokenCount: number
    timestamp: Date
  }
}

export type StoreMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
  type?: 'compact_boundary'
  metadata?: Record<string, unknown>
}

// === Compaction Strategy ===
export interface CompactionStrategy {
  shouldCompact(messages: StoreMessage[], usage: TokenUsage): boolean
  compact(messages: StoreMessage[], model: LanguageModel): Promise<CompactionResult>
}

export interface CompactionResult {
  activeMessages: StoreMessage[]
  appendMessages: StoreMessage[]
  summary: string
  freedTokens: number
  compactedCount: number
}

// === Error Handler ===
export interface ErrorHandler {
  handle(error: Error, attempt: number): Promise<ErrorDecision>
}

export type ErrorDecision =
  | { action: 'retry'; delayMs: number }
  | { action: 'fallback'; model: string }
  | { action: 'abort'; message: string }

// === Tool Call Hook ===
export type ToolCallHook = (params: {
  toolName: string
  toolCallId: string
  input: unknown
}) => Promise<ToolCallDecision>

export type ToolCallDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }

// === Agent Engine Config ===
export interface AgentEngineConfig {
  model: string | LanguageModel
  tools: Record<string, any>
  conversationStore: ConversationStore
  conversationId: string

  systemPrompt?: string
  contextProviders?: ContextProvider[]
  instructions?: string[]

  initialMessages?: StoreMessage[]

  apiKey?: string

  maxSteps?: number
  maxDurationMs?: number
  abortSignal?: AbortSignal
  stopAfterTools?: string[]

  onToolCall?: ToolCallHook
  onError?: ErrorHandler
  compactionStrategy?: CompactionStrategy
}
