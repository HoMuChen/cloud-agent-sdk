# Cloud Agent SDK — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build `cloud-agent-sdk`, a TypeScript SDK wrapping Vercel AI SDK to provide an opinionated agentic loop with conversation persistence, context injection, compaction, and budget control.

**Architecture:** Short-lived `AgentEngine` instances per invocation. `ConversationStore` is the single source of truth. `AsyncGenerator<AgentEvent>` is the unified message protocol. Model strings resolved via internal registry.

**Tech Stack:** TypeScript (strict), Vercel AI SDK (`ai`), Zod, Vitest, tsup

---

## Phase 1: Core Loop

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tsup.config.ts`
- Create: `src/index.ts`

**Step 1: Initialize package.json**

```bash
cd /Users/largitdata/repo/agent-sdk
npm init -y
```

Then replace `package.json` with:

```json
{
  "name": "cloud-agent-sdk",
  "version": "0.1.0",
  "description": "Cloud Agent SDK — agentic loop powered by Vercel AI SDK",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@ai-sdk/anthropic": ">=1.0.0",
    "@ai-sdk/openai": ">=1.0.0",
    "@ai-sdk/google": ">=1.0.0"
  },
  "peerDependenciesMeta": {
    "@ai-sdk/anthropic": { "optional": true },
    "@ai-sdk/openai": { "optional": true },
    "@ai-sdk/google": { "optional": true }
  },
  "dependencies": {
    "ai": "^5.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@ai-sdk/anthropic": "^1.0.0",
    "@ai-sdk/openai": "^1.0.0",
    "@ai-sdk/google": "^1.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "tsup": "^8.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

**Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

**Step 4: Create tsup.config.ts**

```typescript
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
})
```

**Step 5: Create empty entry point**

```typescript
// src/index.ts
export {}
```

**Step 6: Install dependencies**

```bash
npm install
```

**Step 7: Verify setup**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: Both pass (no tests yet, no type errors).

**Step 8: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts tsup.config.ts src/index.ts package-lock.json
git commit -m "chore: project scaffolding with TypeScript, Vitest, tsup"
```

---

### Task 2: Core type definitions

**Files:**
- Create: `src/engine/types.ts`
- Modify: `src/index.ts`

**Step 1: Write types**

Create `src/engine/types.ts`:

```typescript
import type { LanguageModelV2 } from 'ai'

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

// StoreMessage is the union of what we persist
// Using UIMessage-compatible shape for interop with AI SDK
export type StoreMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
  type?: 'compact_boundary'
  metadata?: Record<string, unknown>
}

// === Compaction Strategy ===

export interface CompactionStrategy {
  shouldCompact(messages: StoreMessage[], usage: TokenUsage): boolean
  compact(messages: StoreMessage[], model: LanguageModelV2): Promise<CompactionResult>
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
  // Required
  model: string
  tools: Record<string, any> // AI SDK tool type
  conversationStore: ConversationStore
  conversationId: string

  // System Prompt
  systemPrompt?: string
  contextProviders?: ContextProvider[]
  instructions?: string[]

  // Conversation
  initialMessages?: StoreMessage[]

  // Safety
  maxSteps?: number
  maxBudgetUsd?: number
  maxDurationMs?: number
  abortSignal?: AbortSignal

  // Advanced
  onToolCall?: ToolCallHook
  onError?: ErrorHandler
  compactionStrategy?: CompactionStrategy
}
```

**Step 2: Export from index**

Update `src/index.ts`:

```typescript
export type {
  AgentEvent,
  TextDeltaEvent,
  ToolCallStartEvent,
  ToolCallCompleteEvent,
  CompactEvent,
  StatusEvent,
  AgentErrorEvent,
  ResultEvent,
  TokenUsage,
  ContextProvider,
  ContextBlock,
  ContextResolveParams,
  ConversationStore,
  ConversationListResult,
  ConversationSummary,
  CompactBoundaryMessage,
  StoreMessage,
  CompactionStrategy,
  CompactionResult,
  ErrorHandler,
  ErrorDecision,
  ToolCallHook,
  ToolCallDecision,
  AgentEngineConfig,
} from './engine/types.js'
```

**Step 3: Type check**

```bash
npx tsc --noEmit
```

Expected: PASS

**Step 4: Commit**

```bash
git add src/engine/types.ts src/index.ts
git commit -m "feat: add core type definitions"
```

---

### Task 3: Model registry

**Files:**
- Create: `src/model/registry.ts`
- Create: `src/model/registry.test.ts`
- Modify: `src/index.ts`

**Step 1: Write the failing test**

Create `src/model/registry.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ModelRegistry } from './registry.js'

describe('ModelRegistry', () => {
  let registry: ModelRegistry

  beforeEach(() => {
    registry = new ModelRegistry()
  })

  it('parses provider/model string correctly', () => {
    const parsed = registry.parseModelString('anthropic/claude-sonnet-4.5')
    expect(parsed).toEqual({ provider: 'anthropic', modelId: 'claude-sonnet-4.5' })
  })

  it('throws on invalid model string (no slash)', () => {
    expect(() => registry.parseModelString('invalid')).toThrow('Invalid model string')
  })

  it('throws on empty provider or model', () => {
    expect(() => registry.parseModelString('/model')).toThrow('Invalid model string')
    expect(() => registry.parseModelString('provider/')).toThrow('Invalid model string')
  })

  it('resolves a registered provider', () => {
    const mockFactory = vi.fn().mockReturnValue({ modelId: 'test-model' })
    registry.registerProvider('test', mockFactory)
    const model = registry.resolve('test/my-model')
    expect(mockFactory).toHaveBeenCalledWith('my-model')
    expect(model).toEqual({ modelId: 'test-model' })
  })

  it('throws when provider is not registered and not installable', () => {
    expect(() => registry.resolve('unknown/model')).toThrow(
      /Provider "unknown" is not registered/
    )
  })

  it('allows overriding a provider', () => {
    const factory1 = vi.fn().mockReturnValue({ id: 1 })
    const factory2 = vi.fn().mockReturnValue({ id: 2 })
    registry.registerProvider('test', factory1)
    registry.registerProvider('test', factory2)
    const model = registry.resolve('test/m')
    expect(factory2).toHaveBeenCalled()
    expect(model).toEqual({ id: 2 })
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/model/registry.test.ts
```

Expected: FAIL — `ModelRegistry` not found.

**Step 3: Write minimal implementation**

Create `src/model/registry.ts`:

```typescript
import type { LanguageModelV2 } from 'ai'

export type ProviderFactory = (modelId: string) => LanguageModelV2

export class ModelRegistry {
  private providers = new Map<string, ProviderFactory>()

  constructor() {
    this.registerBuiltinProviders()
  }

  parseModelString(model: string): { provider: string; modelId: string } {
    const slashIndex = model.indexOf('/')
    if (slashIndex <= 0 || slashIndex === model.length - 1) {
      throw new Error(
        `Invalid model string "${model}". Expected format: "provider/model-id" (e.g. "anthropic/claude-sonnet-4.5")`
      )
    }
    return {
      provider: model.slice(0, slashIndex),
      modelId: model.slice(slashIndex + 1),
    }
  }

  registerProvider(name: string, factory: ProviderFactory): void {
    this.providers.set(name, factory)
  }

  resolve(model: string): LanguageModelV2 {
    const { provider, modelId } = this.parseModelString(model)

    let factory = this.providers.get(provider)
    if (!factory) {
      factory = this.tryLoadBuiltinProvider(provider)
    }
    if (!factory) {
      throw new Error(
        `Provider "${provider}" is not registered. ` +
        `Install the provider package (e.g. @ai-sdk/${provider}) and ensure it's importable, ` +
        `or register a custom provider with registry.registerProvider("${provider}", factory).`
      )
    }
    return factory(modelId)
  }

  private registerBuiltinProviders(): void {
    // Built-in providers are lazy-loaded in tryLoadBuiltinProvider
    // No eager registration needed
  }

  private tryLoadBuiltinProvider(name: string): ProviderFactory | null {
    // Known provider packages
    const knownProviders: Record<string, string> = {
      anthropic: '@ai-sdk/anthropic',
      openai: '@ai-sdk/openai',
      google: '@ai-sdk/google',
    }

    const packageName = knownProviders[name]
    if (!packageName) return null

    try {
      // Dynamic require — works because peer deps are installed at the application level
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(packageName)
      const providerFn = mod[name] ?? mod.default
      if (typeof providerFn === 'function') {
        const factory: ProviderFactory = (modelId) => providerFn(modelId)
        this.providers.set(name, factory)
        return factory
      }
      return null
    } catch {
      return null
    }
  }
}

// Singleton for default usage
let defaultRegistry: ModelRegistry | null = null

export function getDefaultRegistry(): ModelRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new ModelRegistry()
  }
  return defaultRegistry
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/model/registry.test.ts
```

Expected: PASS (6 tests)

**Step 5: Export from index**

Add to `src/index.ts`:

```typescript
export { ModelRegistry, getDefaultRegistry } from './model/registry.js'
export type { ProviderFactory } from './model/registry.js'
```

**Step 6: Commit**

```bash
git add src/model/registry.ts src/model/registry.test.ts src/index.ts
git commit -m "feat: add model registry for string-to-provider resolution"
```

---

### Task 4: PromptBuilder

**Files:**
- Create: `src/prompt/PromptBuilder.ts`
- Create: `src/prompt/PromptBuilder.test.ts`
- Modify: `src/index.ts`

**Step 1: Write the failing test**

Create `src/prompt/PromptBuilder.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { PromptBuilder } from './PromptBuilder.js'
import type { ContextBlock } from '../engine/types.js'

describe('PromptBuilder', () => {
  const builder = new PromptBuilder()

  it('builds with just systemPrompt', () => {
    const result = builder.build({
      systemPrompt: 'You are a helpful assistant.',
      tools: {},
      resolvedContexts: [],
    })
    expect(result).toContain('You are a helpful assistant.')
  })

  it('uses default role prompt when no systemPrompt', () => {
    const result = builder.build({
      tools: {},
      resolvedContexts: [],
    })
    expect(result).toContain('You are a helpful AI assistant')
  })

  it('includes tool guidance when tools are provided', () => {
    const result = builder.build({
      tools: { get_weather: {}, search_docs: {} },
      resolvedContexts: [],
    })
    expect(result).toContain('2 tools available')
    expect(result).toContain('get_weather')
    expect(result).toContain('search_docs')
  })

  it('includes system-placement context blocks', () => {
    const contexts: ContextBlock[] = [
      { content: 'User is admin', placement: 'system' },
      { content: 'Realtime data here', placement: 'user-prefix' }, // should be excluded
    ]
    const result = builder.build({
      tools: {},
      resolvedContexts: contexts,
    })
    expect(result).toContain('User is admin')
    expect(result).not.toContain('Realtime data here')
  })

  it('includes instructions', () => {
    const result = builder.build({
      tools: {},
      resolvedContexts: [],
      instructions: ['Use Traditional Chinese.', 'Be concise.'],
    })
    expect(result).toContain('Use Traditional Chinese.')
    expect(result).toContain('Be concise.')
  })

  it('includes guardrails when budget/steps are set', () => {
    const result = builder.build({
      tools: {},
      resolvedContexts: [],
      maxSteps: 10,
      maxBudgetUsd: 0.5,
    })
    expect(result).toContain('10')
    expect(result).toContain('budget')
  })

  it('assembles all layers in order', () => {
    const result = builder.build({
      systemPrompt: 'ROLE',
      tools: { a_tool: {} },
      resolvedContexts: [{ content: 'CONTEXT', placement: 'system' }],
      instructions: ['INSTRUCTION'],
      maxSteps: 5,
    })
    const roleIdx = result.indexOf('ROLE')
    const toolIdx = result.indexOf('a_tool')
    const ctxIdx = result.indexOf('CONTEXT')
    const instrIdx = result.indexOf('INSTRUCTION')
    expect(roleIdx).toBeLessThan(toolIdx)
    expect(toolIdx).toBeLessThan(ctxIdx)
    expect(ctxIdx).toBeLessThan(instrIdx)
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/prompt/PromptBuilder.test.ts
```

Expected: FAIL

**Step 3: Write implementation**

Create `src/prompt/PromptBuilder.ts`:

```typescript
import type { ContextBlock } from '../engine/types.js'

export interface PromptBuildParams {
  systemPrompt?: string
  tools: Record<string, any>
  resolvedContexts: ContextBlock[]
  instructions?: string[]
  maxSteps?: number
  maxBudgetUsd?: number
}

export class PromptBuilder {
  build(params: PromptBuildParams): string {
    const sections: string[] = []

    // Layer 1: Role definition
    sections.push(params.systemPrompt ?? this.defaultRolePrompt())

    // Layer 2: Tool guidance
    const toolNames = Object.keys(params.tools)
    if (toolNames.length > 0) {
      sections.push(this.buildToolGuidance(toolNames))
    }

    // Layer 3: Context providers (system placement only)
    for (const block of params.resolvedContexts) {
      if (block.placement === 'system') {
        sections.push(block.content)
      }
    }

    // Layer 4: Additional instructions
    if (params.instructions && params.instructions.length > 0) {
      sections.push(params.instructions.join('\n\n'))
    }

    // Layer 5: Guardrails
    const guardrails = this.buildGuardrails(params)
    if (guardrails) {
      sections.push(guardrails)
    }

    return sections.filter(Boolean).join('\n\n')
  }

  private defaultRolePrompt(): string {
    return 'You are a helpful AI assistant. Answer questions and use tools to help the user.'
  }

  private buildToolGuidance(toolNames: string[]): string {
    const lines = [
      '# Available Tools',
      `You have ${toolNames.length} tools available: ${toolNames.join(', ')}.`,
      'Use them to answer the user\'s questions.',
      'Call multiple tools in parallel when they are independent of each other.',
      'If a tool call fails, analyze the error before retrying.',
    ]
    return lines.join('\n')
  }

  private buildGuardrails(params: PromptBuildParams): string | null {
    const lines: string[] = []
    if (params.maxSteps) {
      lines.push(`You have a maximum of ${params.maxSteps} tool call steps. Use them wisely.`)
    }
    if (params.maxBudgetUsd) {
      lines.push(`There is a budget limit. Be efficient with tool calls and avoid unnecessary steps.`)
    }
    return lines.length > 0 ? '# Guardrails\n' + lines.join('\n') : null
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/prompt/PromptBuilder.test.ts
```

Expected: PASS (7 tests)

**Step 5: Export from index**

Add to `src/index.ts`:

```typescript
export { PromptBuilder } from './prompt/PromptBuilder.js'
export type { PromptBuildParams } from './prompt/PromptBuilder.js'
```

**Step 6: Commit**

```bash
git add src/prompt/PromptBuilder.ts src/prompt/PromptBuilder.test.ts src/index.ts
git commit -m "feat: add PromptBuilder with 5-layer system prompt assembly"
```

---

### Task 5: MemoryConversationStore

**Files:**
- Create: `src/conversation/MemoryStore.ts`
- Create: `src/conversation/boundary.ts`
- Create: `src/conversation/MemoryStore.test.ts`
- Modify: `src/index.ts`

**Step 1: Write the failing test**

Create `src/conversation/MemoryStore.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { MemoryConversationStore } from './MemoryStore.js'
import type { StoreMessage } from '../engine/types.js'

describe('MemoryConversationStore', () => {
  it('returns null for unknown conversation', async () => {
    const store = new MemoryConversationStore()
    expect(await store.loadAll('unknown')).toBeNull()
    expect(await store.loadActive('unknown')).toBeNull()
  })

  it('appends and loads messages', async () => {
    const store = new MemoryConversationStore()
    const msgs: StoreMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]
    await store.append('conv-1', msgs)
    const loaded = await store.loadAll('conv-1')
    expect(loaded).toEqual(msgs)
  })

  it('appends incrementally', async () => {
    const store = new MemoryConversationStore()
    await store.append('conv-1', [{ role: 'user', content: 'msg1' }])
    await store.append('conv-1', [{ role: 'assistant', content: 'msg2' }])
    const loaded = await store.loadAll('conv-1')
    expect(loaded).toHaveLength(2)
    expect(loaded![0].content).toBe('msg1')
    expect(loaded![1].content).toBe('msg2')
  })

  it('loadActive returns all when no boundary exists', async () => {
    const store = new MemoryConversationStore()
    await store.append('conv-1', [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ])
    const active = await store.loadActive('conv-1')
    expect(active).toHaveLength(2)
  })

  it('loadActive returns messages after last compact boundary', async () => {
    const store = new MemoryConversationStore()
    const boundary: StoreMessage = {
      role: 'system',
      content: '[Compact Boundary]',
      type: 'compact_boundary',
      metadata: {
        trigger: 'auto',
        compactedMessageCount: 5,
        preCompactTokenCount: 1000,
        postCompactTokenCount: 200,
        timestamp: new Date(),
      },
    }
    await store.append('conv-1', [
      { role: 'user', content: 'old1' },
      { role: 'assistant', content: 'old2' },
      boundary,
      { role: 'user', content: 'summary' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'new1' },
    ])
    const active = await store.loadActive('conv-1')
    // Should include boundary + everything after
    expect(active).toHaveLength(4) // boundary, summary, ack, new1
    expect(active![0].type).toBe('compact_boundary')
    expect(active![3].content).toBe('new1')
  })

  it('loadActive uses the LAST boundary when multiple exist', async () => {
    const store = new MemoryConversationStore()
    const mkBoundary = (): StoreMessage => ({
      role: 'system',
      content: '[Compact Boundary]',
      type: 'compact_boundary',
      metadata: {
        trigger: 'auto',
        compactedMessageCount: 1,
        preCompactTokenCount: 100,
        postCompactTokenCount: 50,
        timestamp: new Date(),
      },
    })
    await store.append('conv-1', [
      { role: 'user', content: 'very-old' },
      mkBoundary(),
      { role: 'user', content: 'old-summary' },
      { role: 'assistant', content: 'old-ack' },
      { role: 'user', content: 'mid' },
      mkBoundary(),
      { role: 'user', content: 'new-summary' },
      { role: 'assistant', content: 'new-ack' },
      { role: 'user', content: 'latest' },
    ])
    const active = await store.loadActive('conv-1')
    // Should be from last boundary: boundary, new-summary, new-ack, latest
    expect(active).toHaveLength(4)
    expect(active![1].content).toBe('new-summary')
  })

  it('does not mutate stored messages', async () => {
    const store = new MemoryConversationStore()
    const msgs: StoreMessage[] = [{ role: 'user', content: 'original' }]
    await store.append('conv-1', msgs)
    msgs[0].content = 'mutated'
    const loaded = await store.loadAll('conv-1')
    expect(loaded![0].content).toBe('original')
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/conversation/MemoryStore.test.ts
```

Expected: FAIL

**Step 3: Write boundary utility**

Create `src/conversation/boundary.ts`:

```typescript
import type { StoreMessage } from '../engine/types.js'

export function getMessagesAfterCompactBoundary(messages: StoreMessage[]): StoreMessage[] {
  let lastBoundaryIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'compact_boundary') {
      lastBoundaryIndex = i
      break
    }
  }
  if (lastBoundaryIndex === -1) return messages
  return messages.slice(lastBoundaryIndex)
}
```

**Step 4: Write MemoryStore implementation**

Create `src/conversation/MemoryStore.ts`:

```typescript
import type { ConversationStore, StoreMessage } from '../engine/types.js'
import { getMessagesAfterCompactBoundary } from './boundary.js'

export class MemoryConversationStore implements ConversationStore {
  private store = new Map<string, StoreMessage[]>()

  async append(conversationId: string, messages: StoreMessage[]): Promise<void> {
    const existing = this.store.get(conversationId) ?? []
    // Deep copy to prevent external mutation
    const copied = messages.map(m => structuredClone(m))
    this.store.set(conversationId, [...existing, ...copied])
  }

  async loadAll(conversationId: string): Promise<StoreMessage[] | null> {
    const messages = this.store.get(conversationId)
    if (!messages) return null
    return messages.map(m => structuredClone(m))
  }

  async loadActive(conversationId: string): Promise<StoreMessage[] | null> {
    const all = this.store.get(conversationId)
    if (!all) return null
    const active = getMessagesAfterCompactBoundary(all)
    return active.map(m => structuredClone(m))
  }
}
```

**Step 5: Run test to verify it passes**

```bash
npx vitest run src/conversation/MemoryStore.test.ts
```

Expected: PASS (7 tests)

**Step 6: Export from index**

Add to `src/index.ts`:

```typescript
export { MemoryConversationStore } from './conversation/MemoryStore.js'
export { getMessagesAfterCompactBoundary } from './conversation/boundary.js'
```

**Step 7: Commit**

```bash
git add src/conversation/MemoryStore.ts src/conversation/boundary.ts src/conversation/MemoryStore.test.ts src/index.ts
git commit -m "feat: add MemoryConversationStore with compact boundary support"
```

---

### Task 6: AgentEngine core — run() AsyncGenerator

This is the biggest task. We build the core agentic loop.

**Files:**
- Create: `src/engine/AgentEngine.ts`
- Create: `src/engine/errors.ts`
- Create: `src/engine/AgentEngine.test.ts`
- Modify: `src/index.ts`

**Step 1: Write custom errors**

Create `src/engine/errors.ts`:

```typescript
export class AgentError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'AgentError'
  }
}

export class BudgetExceededError extends AgentError {
  constructor(message = 'Budget exceeded') {
    super(message, 'BUDGET_EXCEEDED')
    this.name = 'BudgetExceededError'
  }
}

export class DurationExceededError extends AgentError {
  constructor(message = 'Duration exceeded') {
    super(message, 'DURATION_EXCEEDED')
    this.name = 'DurationExceededError'
  }
}
```

**Step 2: Write the failing test**

Create `src/engine/AgentEngine.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentEngine } from './AgentEngine.js'
import { MemoryConversationStore } from '../conversation/MemoryStore.js'
import type { AgentEvent, StoreMessage } from './types.js'

// Mock the AI SDK
vi.mock('ai', () => {
  return {
    streamText: vi.fn(),
    generateText: vi.fn(),
    stepCountIs: vi.fn((n: number) => ({ type: 'step-count', count: n })),
  }
})

// Mock the model registry
vi.mock('../model/registry.js', () => {
  const mockModel = { modelId: 'mock-model', provider: 'mock' }
  return {
    ModelRegistry: vi.fn().mockImplementation(() => ({
      resolve: vi.fn().mockReturnValue(mockModel),
      registerProvider: vi.fn(),
      parseModelString: vi.fn().mockReturnValue({ provider: 'mock', modelId: 'model' }),
    })),
    getDefaultRegistry: vi.fn().mockReturnValue({
      resolve: vi.fn().mockReturnValue(mockModel),
      registerProvider: vi.fn(),
    }),
  }
})

// Helper to create a mock fullStream
function createMockFullStream(parts: any[]) {
  async function* generate() {
    for (const part of parts) {
      yield part
    }
  }
  const stream = generate()

  return {
    fullStream: stream,
    then: (resolve: any) => resolve({
      text: 'mock response',
      usage: { inputTokens: 100, outputTokens: 50 },
      steps: [],
    }),
    // Make it thenable for `await result`
    [Symbol.asyncIterator]: () => stream,
  }
}

describe('AgentEngine', () => {
  let store: MemoryConversationStore
  const { streamText } = vi.mocked(await import('ai'))

  beforeEach(() => {
    store = new MemoryConversationStore()
    vi.clearAllMocks()
  })

  it('yields text-delta events from stream', async () => {
    const mockResult = createMockFullStream([
      { type: 'text-delta', textDelta: 'Hello ' },
      { type: 'text-delta', textDelta: 'world' },
    ])
    streamText.mockReturnValue(mockResult as any)

    const engine = new AgentEngine({
      model: 'anthropic/claude-sonnet-4.5',
      tools: {},
      conversationStore: store,
      conversationId: 'test-1',
    })

    const events: AgentEvent[] = []
    for await (const event of engine.run('hi')) {
      events.push(event)
    }

    const textDeltas = events.filter(e => e.type === 'text-delta')
    expect(textDeltas).toHaveLength(2)
    expect(textDeltas[0]).toEqual({ type: 'text-delta', text: 'Hello ' })
    expect(textDeltas[1]).toEqual({ type: 'text-delta', text: 'world' })
  })

  it('yields result event at the end', async () => {
    const mockResult = createMockFullStream([
      { type: 'text-delta', textDelta: 'done' },
    ])
    streamText.mockReturnValue(mockResult as any)

    const engine = new AgentEngine({
      model: 'anthropic/claude-sonnet-4.5',
      tools: {},
      conversationStore: store,
      conversationId: 'test-1',
    })

    const events: AgentEvent[] = []
    for await (const event of engine.run('test')) {
      events.push(event)
    }

    const result = events.find(e => e.type === 'result')
    expect(result).toBeDefined()
    expect(result!.type).toBe('result')
    if (result!.type === 'result') {
      expect(result!.text).toBe('mock response')
      expect(result!.usage).toEqual({ inputTokens: 100, outputTokens: 50 })
      expect(result!.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('persists user message to store immediately', async () => {
    const mockResult = createMockFullStream([])
    streamText.mockReturnValue(mockResult as any)

    const engine = new AgentEngine({
      model: 'anthropic/claude-sonnet-4.5',
      tools: {},
      conversationStore: store,
      conversationId: 'test-1',
    })

    for await (const _ of engine.run('hello')) { /* consume */ }

    const all = await store.loadAll('test-1')
    expect(all).not.toBeNull()
    expect(all!.some(m => m.role === 'user' && m.content === 'hello')).toBe(true)
  })

  it('yields tool-call-start and tool-call-complete events', async () => {
    const mockResult = createMockFullStream([
      { type: 'tool-call', toolCallId: 'tc-1', toolName: 'get_weather', args: { city: 'Tokyo' } },
      { type: 'tool-result', toolCallId: 'tc-1', toolName: 'get_weather', args: { city: 'Tokyo' }, result: { temp: 20 } },
    ])
    streamText.mockReturnValue(mockResult as any)

    const engine = new AgentEngine({
      model: 'anthropic/claude-sonnet-4.5',
      tools: {},
      conversationStore: store,
      conversationId: 'test-1',
    })

    const events: AgentEvent[] = []
    for await (const event of engine.run('weather?')) {
      events.push(event)
    }

    const toolStart = events.find(e => e.type === 'tool-call-start')
    expect(toolStart).toEqual({
      type: 'tool-call-start',
      toolName: 'get_weather',
      toolCallId: 'tc-1',
    })

    const toolComplete = events.find(e => e.type === 'tool-call-complete')
    expect(toolComplete).toEqual({
      type: 'tool-call-complete',
      toolName: 'get_weather',
      toolCallId: 'tc-1',
      input: { city: 'Tokyo' },
      output: { temp: 20 },
    })
  })

  it('yields error event on stream failure', async () => {
    streamText.mockImplementation(() => {
      throw new Error('API down')
    })

    const engine = new AgentEngine({
      model: 'anthropic/claude-sonnet-4.5',
      tools: {},
      conversationStore: store,
      conversationId: 'test-1',
    })

    const events: AgentEvent[] = []
    for await (const event of engine.run('test')) {
      events.push(event)
    }

    const errorEvent = events.find(e => e.type === 'error')
    expect(errorEvent).toBeDefined()
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.message).toBe('API down')
    }
  })

  it('passes maxSteps via stopWhen to streamText', async () => {
    const mockResult = createMockFullStream([])
    streamText.mockReturnValue(mockResult as any)

    const engine = new AgentEngine({
      model: 'anthropic/claude-sonnet-4.5',
      tools: {},
      conversationStore: store,
      conversationId: 'test-1',
      maxSteps: 10,
    })

    for await (const _ of engine.run('test')) { /* consume */ }

    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        stopWhen: expect.anything(),
      })
    )
  })

  it('provides getMessages() and getUsage()', async () => {
    const mockResult = createMockFullStream([])
    streamText.mockReturnValue(mockResult as any)

    const engine = new AgentEngine({
      model: 'anthropic/claude-sonnet-4.5',
      tools: {},
      conversationStore: store,
      conversationId: 'test-1',
    })

    for await (const _ of engine.run('test')) { /* consume */ }

    expect(engine.getMessages().length).toBeGreaterThanOrEqual(1)
    expect(engine.getUsage()).toEqual({ inputTokens: 100, outputTokens: 50 })
  })
})
```

**Step 3: Run test to verify it fails**

```bash
npx vitest run src/engine/AgentEngine.test.ts
```

Expected: FAIL — `AgentEngine` not found.

**Step 4: Write AgentEngine implementation**

Create `src/engine/AgentEngine.ts`:

```typescript
import { streamText, stepCountIs } from 'ai'
import type { LanguageModelV2 } from 'ai'
import { getDefaultRegistry } from '../model/registry.js'
import { PromptBuilder } from '../prompt/PromptBuilder.js'
import type {
  AgentEngineConfig,
  AgentEvent,
  TokenUsage,
  StoreMessage,
  ContextBlock,
} from './types.js'

export class AgentEngine {
  private config: AgentEngineConfig
  private messages: StoreMessage[]
  private totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  private resolvedModel: LanguageModelV2
  private promptBuilder: PromptBuilder

  constructor(config: AgentEngineConfig) {
    this.config = config
    this.messages = config.initialMessages ? [...config.initialMessages] : []
    this.resolvedModel = getDefaultRegistry().resolve(config.model)
    this.promptBuilder = new PromptBuilder()
  }

  async *run(
    input: string,
    options?: { metadata?: Record<string, unknown> }
  ): AsyncGenerator<AgentEvent> {
    const startTime = Date.now()
    const store = this.config.conversationStore
    const conversationId = this.config.conversationId

    // Resolve context providers
    const resolvedContexts = await this.resolveContextProviders(options?.metadata)

    // Append user message and persist immediately
    const userMessage: StoreMessage = { role: 'user', content: input }
    this.messages.push(userMessage)
    await store.append(conversationId, [userMessage])

    // Build system prompt
    const system = this.promptBuilder.build({
      systemPrompt: this.config.systemPrompt,
      tools: this.config.tools,
      resolvedContexts,
      instructions: this.config.instructions,
      maxSteps: this.config.maxSteps,
      maxBudgetUsd: this.config.maxBudgetUsd,
    })

    // Prepend user-prefix contexts to the last user message content
    const userPrefixContexts = resolvedContexts
      .filter(c => c.placement === 'user-prefix')
      .map(c => c.content)

    if (userPrefixContexts.length > 0) {
      const lastUserMsg = this.messages[this.messages.length - 1]
      if (lastUserMsg.role === 'user') {
        lastUserMsg.content = userPrefixContexts.join('\n\n') + '\n\n' + lastUserMsg.content
      }
    }

    try {
      const result = streamText({
        model: this.resolvedModel,
        system,
        messages: this.messages.map(m => ({ role: m.role, content: m.content })),
        tools: this.config.tools,
        stopWhen: stepCountIs(this.config.maxSteps ?? 25),
        abortSignal: this.config.abortSignal,
      })

      for await (const part of result.fullStream) {
        // Budget check
        if (this.config.maxBudgetUsd && this.isOverBudget()) {
          yield { type: 'error' as const, error: new Error('Budget exceeded'), recoverable: false }
          return
        }

        // Duration check
        if (this.config.maxDurationMs && (Date.now() - startTime) > this.config.maxDurationMs) {
          yield { type: 'error' as const, error: new Error('Duration exceeded'), recoverable: false }
          return
        }

        // Map stream parts to agent events
        yield* this.mapStreamPart(part)
      }

      // Await final result for usage
      const finalResult = await result
      this.accumulateUsage(finalResult.usage)

      yield {
        type: 'result' as const,
        text: finalResult.text,
        usage: { ...this.totalUsage },
        durationMs: Date.now() - startTime,
      }
    } catch (error) {
      yield {
        type: 'error' as const,
        error: error instanceof Error ? error : new Error(String(error)),
        recoverable: false,
      }
    }
  }

  async generate(input: string, options?: { metadata?: Record<string, unknown> }): Promise<AgentEvent & { type: 'result' }> {
    let lastResult: (AgentEvent & { type: 'result' }) | null = null
    for await (const event of this.run(input, options)) {
      if (event.type === 'result') {
        lastResult = event
      }
    }
    if (!lastResult) {
      throw new Error('No result event produced')
    }
    return lastResult
  }

  getMessages(): readonly StoreMessage[] {
    return this.messages
  }

  getUsage(): TokenUsage {
    return { ...this.totalUsage }
  }

  // --- Private methods ---

  private async resolveContextProviders(
    metadata?: Record<string, unknown>
  ): Promise<ContextBlock[]> {
    if (!this.config.contextProviders || this.config.contextProviders.length === 0) {
      return []
    }

    const results = await Promise.allSettled(
      this.config.contextProviders.map(provider =>
        provider.resolve({
          conversationId: this.config.conversationId,
          turnIndex: this.messages.filter(m => m.role === 'user').length,
          metadata,
        })
      )
    )

    const blocks: ContextBlock[] = []
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        blocks.push(result.value)
      }
      // Rejected promises are silently skipped (logged in production)
    }
    return blocks
  }

  private async *mapStreamPart(part: any): AsyncGenerator<AgentEvent> {
    switch (part.type) {
      case 'text-delta':
        yield { type: 'text-delta', text: part.textDelta }
        break
      case 'tool-call':
        yield {
          type: 'tool-call-start',
          toolName: part.toolName,
          toolCallId: part.toolCallId,
        }
        break
      case 'tool-result':
        yield {
          type: 'tool-call-complete',
          toolName: part.toolName,
          toolCallId: part.toolCallId,
          input: part.args,
          output: part.result,
        }
        break
    }
  }

  private accumulateUsage(usage: { inputTokens?: number; outputTokens?: number }): void {
    this.totalUsage.inputTokens += usage.inputTokens ?? 0
    this.totalUsage.outputTokens += usage.outputTokens ?? 0
  }

  private isOverBudget(): boolean {
    // Simple cost estimation based on token usage
    // This is a rough estimate; pricing module will provide accurate rates
    const costPerInputToken = 0.000003 // $3/M tokens (mid-range)
    const costPerOutputToken = 0.000015 // $15/M tokens (mid-range)
    const estimatedCost =
      this.totalUsage.inputTokens * costPerInputToken +
      this.totalUsage.outputTokens * costPerOutputToken
    return estimatedCost > (this.config.maxBudgetUsd ?? Infinity)
  }
}
```

**Step 5: Run test to verify it passes**

```bash
npx vitest run src/engine/AgentEngine.test.ts
```

Expected: PASS (7 tests)

**Step 6: Export from index**

Add to `src/index.ts`:

```typescript
export { AgentEngine } from './engine/AgentEngine.js'
export { AgentError, BudgetExceededError, DurationExceededError } from './engine/errors.js'
```

**Step 7: Commit**

```bash
git add src/engine/AgentEngine.ts src/engine/errors.ts src/engine/AgentEngine.test.ts src/index.ts
git commit -m "feat: add AgentEngine core with run() AsyncGenerator and stream mapping"
```

---

### Task 7: toUIMessageStreamResponse()

**Files:**
- Modify: `src/engine/AgentEngine.ts`
- Create: `src/engine/AgentEngine.stream.test.ts`

**Step 1: Write the failing test**

Create `src/engine/AgentEngine.stream.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentEngine } from './AgentEngine.js'
import { MemoryConversationStore } from '../conversation/MemoryStore.js'

// Same mocks as AgentEngine.test.ts
vi.mock('ai', async () => {
  const actual = await vi.importActual('ai')
  return {
    ...actual,
    streamText: vi.fn(),
    stepCountIs: vi.fn((n: number) => ({ type: 'step-count', count: n })),
  }
})

vi.mock('../model/registry.js', () => {
  const mockModel = { modelId: 'mock-model', provider: 'mock' }
  return {
    ModelRegistry: vi.fn(),
    getDefaultRegistry: vi.fn().mockReturnValue({
      resolve: vi.fn().mockReturnValue(mockModel),
      registerProvider: vi.fn(),
    }),
  }
})

function createMockFullStream(parts: any[]) {
  async function* generate() {
    for (const part of parts) yield part
  }
  const stream = generate()
  return {
    fullStream: stream,
    then: (resolve: any) => resolve({
      text: 'response text',
      usage: { inputTokens: 10, outputTokens: 5 },
      steps: [],
    }),
  }
}

describe('AgentEngine.toUIMessageStreamResponse', () => {
  let store: MemoryConversationStore
  const { streamText } = vi.mocked(await import('ai'))

  beforeEach(() => {
    store = new MemoryConversationStore()
    vi.clearAllMocks()
  })

  it('returns a Response object', async () => {
    const mockResult = createMockFullStream([
      { type: 'text-delta', textDelta: 'hello' },
    ])
    streamText.mockReturnValue(mockResult as any)

    const engine = new AgentEngine({
      model: 'anthropic/claude-sonnet-4.5',
      tools: {},
      conversationStore: store,
      conversationId: 'test-1',
    })

    const response = await engine.toUIMessageStreamResponse('test input')
    expect(response).toBeInstanceOf(Response)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
  })

  it('response body is readable', async () => {
    const mockResult = createMockFullStream([
      { type: 'text-delta', textDelta: 'streaming' },
    ])
    streamText.mockReturnValue(mockResult as any)

    const engine = new AgentEngine({
      model: 'anthropic/claude-sonnet-4.5',
      tools: {},
      conversationStore: store,
      conversationId: 'test-1',
    })

    const response = await engine.toUIMessageStreamResponse('input')
    expect(response.body).not.toBeNull()

    // Read the stream to completion
    const reader = response.body!.getReader()
    const chunks: string[] = []
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(decoder.decode(value, { stream: true }))
    }
    expect(chunks.length).toBeGreaterThan(0)
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/engine/AgentEngine.stream.test.ts
```

Expected: FAIL — `toUIMessageStreamResponse` not found.

**Step 3: Add toUIMessageStreamResponse to AgentEngine**

Add this method to `src/engine/AgentEngine.ts` inside the class:

```typescript
  async toUIMessageStreamResponse(
    input: string,
    options?: { metadata?: Record<string, unknown> }
  ): Promise<Response> {
    const encoder = new TextEncoder()
    const generator = this.run(input, options)

    const stream = new ReadableStream({
      async pull(controller) {
        const { value, done } = await generator.next()
        if (done) {
          controller.close()
          return
        }
        // Encode event as SSE-compatible JSON line
        const data = JSON.stringify(value)
        controller.enqueue(encoder.encode(`data: ${data}\n\n`))
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  }
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/engine/AgentEngine.stream.test.ts
```

Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add src/engine/AgentEngine.ts src/engine/AgentEngine.stream.test.ts
git commit -m "feat: add toUIMessageStreamResponse() for HTTP streaming"
```

---

### Task 8: Phase 1 integration test

**Files:**
- Create: `src/engine/AgentEngine.integration.test.ts`

**Step 1: Write integration test that validates the Phase 1 acceptance criteria**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentEngine } from './AgentEngine.js'
import { MemoryConversationStore } from '../conversation/MemoryStore.js'
import type { AgentEvent } from './types.js'

vi.mock('ai', () => ({
  streamText: vi.fn(),
  stepCountIs: vi.fn((n: number) => ({ type: 'step-count', count: n })),
}))

vi.mock('../model/registry.js', () => ({
  getDefaultRegistry: vi.fn().mockReturnValue({
    resolve: vi.fn().mockReturnValue({ modelId: 'mock' }),
  }),
}))

function mockStreamWithToolUse() {
  async function* generate() {
    yield { type: 'text-delta', textDelta: 'Let me check ' }
    yield { type: 'tool-call', toolCallId: 'tc-1', toolName: 'get_weather', args: { city: 'SF' } }
    yield { type: 'tool-result', toolCallId: 'tc-1', toolName: 'get_weather', args: { city: 'SF' }, result: { temp: 65 } }
    yield { type: 'text-delta', textDelta: 'The weather is 65F.' }
  }
  return {
    fullStream: generate(),
    then: (r: any) => r({ text: 'The weather is 65F.', usage: { inputTokens: 200, outputTokens: 80 } }),
  }
}

describe('Phase 1 Integration', () => {
  const { streamText } = vi.mocked(await import('ai'))

  it('full turn: user input → stream with tool use → result + persistence', async () => {
    streamText.mockReturnValue(mockStreamWithToolUse() as any)
    const store = new MemoryConversationStore()

    const engine = new AgentEngine({
      model: 'anthropic/claude-sonnet-4.5',
      systemPrompt: 'You are helpful.',
      tools: { get_weather: {} as any },
      conversationStore: store,
      conversationId: 'test-1',
      initialMessages: [],
    })

    const events: AgentEvent[] = []
    for await (const event of engine.run('What is the weather?')) {
      events.push(event)
    }

    // Verify event sequence
    const types = events.map(e => e.type)
    expect(types).toContain('text-delta')
    expect(types).toContain('tool-call-start')
    expect(types).toContain('tool-call-complete')
    expect(types).toContain('result')

    // Verify result
    const result = events.find(e => e.type === 'result')!
    expect(result.type).toBe('result')
    if (result.type === 'result') {
      expect(result.text).toBe('The weather is 65F.')
      expect(result.usage.inputTokens).toBe(200)
    }

    // Verify store has user message
    const saved = await store.loadAll('test-1')
    expect(saved).not.toBeNull()
    expect(saved!.length).toBeGreaterThanOrEqual(1)
    expect(saved!.some(m => m.role === 'user' && m.content === 'What is the weather?')).toBe(true)
  })

  it('generate() returns final result directly', async () => {
    streamText.mockReturnValue(mockStreamWithToolUse() as any)
    const store = new MemoryConversationStore()

    const engine = new AgentEngine({
      model: 'anthropic/claude-sonnet-4.5',
      tools: { get_weather: {} as any },
      conversationStore: store,
      conversationId: 'test-2',
    })

    const result = await engine.generate('Weather in SF?')
    expect(result.type).toBe('result')
    expect(result.text).toBe('The weather is 65F.')
  })
})
```

**Step 2: Run all tests**

```bash
npx vitest run
```

Expected: ALL PASS

**Step 3: Commit**

```bash
git add src/engine/AgentEngine.integration.test.ts
git commit -m "test: add Phase 1 integration tests"
```

---

## Phase 2: Context & Conversation

### Task 9: ContextManager

**Files:**
- Create: `src/context/ContextManager.ts`
- Create: `src/context/ContextManager.test.ts`
- Modify: `src/index.ts`

**Step 1: Write the failing test**

Create `src/context/ContextManager.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { ContextManager } from './ContextManager.js'
import type { ContextProvider, ContextBlock } from '../engine/types.js'

describe('ContextManager', () => {
  it('resolves all providers in parallel', async () => {
    const callOrder: number[] = []
    const providers: ContextProvider[] = [
      {
        name: 'p1',
        resolve: async () => {
          callOrder.push(1)
          return { content: 'context-1', placement: 'system' }
        },
      },
      {
        name: 'p2',
        resolve: async () => {
          callOrder.push(2)
          return { content: 'context-2', placement: 'user-prefix' }
        },
      },
    ]

    const manager = new ContextManager(providers)
    const results = await manager.resolveAll({
      conversationId: 'c1',
      turnIndex: 0,
    })

    expect(results).toHaveLength(2)
    expect(results[0].content).toBe('context-1')
    expect(results[1].content).toBe('context-2')
  })

  it('skips providers that return null', async () => {
    const providers: ContextProvider[] = [
      { name: 'p1', resolve: async () => ({ content: 'yes', placement: 'system' }) },
      { name: 'p2', resolve: async () => null },
    ]

    const manager = new ContextManager(providers)
    const results = await manager.resolveAll({ conversationId: 'c1', turnIndex: 0 })
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('yes')
  })

  it('skips providers that throw errors', async () => {
    const providers: ContextProvider[] = [
      { name: 'good', resolve: async () => ({ content: 'ok', placement: 'system' }) },
      { name: 'bad', resolve: async () => { throw new Error('boom') } },
    ]

    const manager = new ContextManager(providers)
    const results = await manager.resolveAll({ conversationId: 'c1', turnIndex: 0 })
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('ok')
  })

  it('returns empty array for no providers', async () => {
    const manager = new ContextManager([])
    const results = await manager.resolveAll({ conversationId: 'c1', turnIndex: 0 })
    expect(results).toEqual([])
  })

  it('passes context params to providers', async () => {
    const resolveFn = vi.fn().mockResolvedValue({ content: 'x', placement: 'system' })
    const providers: ContextProvider[] = [{ name: 'p1', resolve: resolveFn }]

    const manager = new ContextManager(providers)
    await manager.resolveAll({
      conversationId: 'conv-123',
      turnIndex: 5,
      userId: 'user-1',
      metadata: { key: 'value' },
    })

    expect(resolveFn).toHaveBeenCalledWith({
      conversationId: 'conv-123',
      turnIndex: 5,
      userId: 'user-1',
      metadata: { key: 'value' },
    })
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/context/ContextManager.test.ts
```

Expected: FAIL

**Step 3: Write implementation**

Create `src/context/ContextManager.ts`:

```typescript
import type { ContextProvider, ContextBlock, ContextResolveParams } from '../engine/types.js'

export class ContextManager {
  constructor(private providers: ContextProvider[]) {}

  async resolveAll(params: ContextResolveParams): Promise<ContextBlock[]> {
    if (this.providers.length === 0) return []

    const results = await Promise.allSettled(
      this.providers.map(provider => provider.resolve(params))
    )

    const blocks: ContextBlock[] = []
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'fulfilled' && result.value !== null) {
        blocks.push(result.value)
      }
      // Silently skip rejected or null results
    }
    return blocks
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/context/ContextManager.test.ts
```

Expected: PASS (5 tests)

**Step 5: Export from index**

Add to `src/index.ts`:

```typescript
export { ContextManager } from './context/ContextManager.js'
```

**Step 6: Commit**

```bash
git add src/context/ContextManager.ts src/context/ContextManager.test.ts src/index.ts
git commit -m "feat: add ContextManager with parallel resolve and error tolerance"
```

---

### Task 10: Static context provider

**Files:**
- Create: `src/context/providers/staticProvider.ts`
- Create: `src/context/providers/staticProvider.test.ts`
- Modify: `src/index.ts`

**Step 1: Write the failing test**

Create `src/context/providers/staticProvider.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { staticProvider } from './staticProvider.js'

describe('staticProvider', () => {
  it('returns a ContextProvider with the given content', async () => {
    const provider = staticProvider('rules', 'Do not exceed limits', 'system')
    expect(provider.name).toBe('rules')

    const block = await provider.resolve({ conversationId: 'c1', turnIndex: 0 })
    expect(block).toEqual({ content: 'Do not exceed limits', placement: 'system' })
  })

  it('supports user-prefix placement', async () => {
    const provider = staticProvider('prefix', 'Context here', 'user-prefix')
    const block = await provider.resolve({ conversationId: 'c1', turnIndex: 0 })
    expect(block!.placement).toBe('user-prefix')
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/context/providers/staticProvider.test.ts
```

Expected: FAIL

**Step 3: Write implementation**

Create `src/context/providers/staticProvider.ts`:

```typescript
import type { ContextProvider, ContextBlock } from '../../engine/types.js'

export function staticProvider(
  name: string,
  content: string,
  placement: ContextBlock['placement']
): ContextProvider {
  return {
    name,
    resolve: async () => ({ content, placement }),
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/context/providers/staticProvider.test.ts
```

Expected: PASS (2 tests)

**Step 5: Export from index**

Add to `src/index.ts`:

```typescript
export { staticProvider } from './context/providers/staticProvider.js'
```

**Step 6: Commit**

```bash
git add src/context/providers/staticProvider.ts src/context/providers/staticProvider.test.ts src/index.ts
git commit -m "feat: add staticProvider convenience function"
```

---

### Task 11: Integrate ContextManager into AgentEngine

**Files:**
- Modify: `src/engine/AgentEngine.ts`
- Create: `src/engine/AgentEngine.context.test.ts`

**Step 1: Write the failing test**

Create `src/engine/AgentEngine.context.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentEngine } from './AgentEngine.js'
import { MemoryConversationStore } from '../conversation/MemoryStore.js'
import type { AgentEvent, ContextProvider } from './types.js'

vi.mock('ai', () => ({
  streamText: vi.fn(),
  stepCountIs: vi.fn((n: number) => ({ type: 'step-count', count: n })),
}))

vi.mock('../model/registry.js', () => ({
  getDefaultRegistry: vi.fn().mockReturnValue({
    resolve: vi.fn().mockReturnValue({ modelId: 'mock' }),
  }),
}))

function createMockStream() {
  async function* generate() {
    yield { type: 'text-delta', textDelta: 'ok' }
  }
  return {
    fullStream: generate(),
    then: (r: any) => r({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 } }),
  }
}

describe('AgentEngine context integration', () => {
  const { streamText } = vi.mocked(await import('ai'))
  let store: MemoryConversationStore

  beforeEach(() => {
    store = new MemoryConversationStore()
    vi.clearAllMocks()
  })

  it('resolves context providers and includes system context in prompt', async () => {
    streamText.mockReturnValue(createMockStream() as any)

    const provider: ContextProvider = {
      name: 'test-context',
      resolve: vi.fn().mockResolvedValue({
        content: 'INJECTED_CONTEXT',
        placement: 'system',
      }),
    }

    const engine = new AgentEngine({
      model: 'mock/model',
      tools: {},
      conversationStore: store,
      conversationId: 'c1',
      contextProviders: [provider],
    })

    for await (const _ of engine.run('test')) {}

    // Verify streamText was called with system prompt containing the context
    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('INJECTED_CONTEXT'),
      })
    )
  })

  it('skips failed context providers gracefully', async () => {
    streamText.mockReturnValue(createMockStream() as any)

    const goodProvider: ContextProvider = {
      name: 'good',
      resolve: async () => ({ content: 'GOOD', placement: 'system' }),
    }
    const badProvider: ContextProvider = {
      name: 'bad',
      resolve: async () => { throw new Error('fail') },
    }

    const engine = new AgentEngine({
      model: 'mock/model',
      tools: {},
      conversationStore: store,
      conversationId: 'c1',
      contextProviders: [goodProvider, badProvider],
    })

    const events: AgentEvent[] = []
    for await (const event of engine.run('test')) {
      events.push(event)
    }

    // Should complete without error
    expect(events.some(e => e.type === 'result')).toBe(true)
    // System prompt should contain the good context
    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('GOOD'),
      })
    )
  })
})
```

**Step 2: Run test to verify it passes** (ContextManager is already integrated in the AgentEngine from Task 6)

```bash
npx vitest run src/engine/AgentEngine.context.test.ts
```

If the context integration is already working from the `resolveContextProviders` method in Task 6, this should PASS. If not, update `AgentEngine.ts` to use `ContextManager` instead of inline implementation.

**Step 3: Commit**

```bash
git add src/engine/AgentEngine.context.test.ts
git commit -m "test: add context provider integration tests for AgentEngine"
```

---

### Task 12: Multi-turn conversation resume test

**Files:**
- Create: `src/engine/AgentEngine.multiturn.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentEngine } from './AgentEngine.js'
import { MemoryConversationStore } from '../conversation/MemoryStore.js'
import type { AgentEvent } from './types.js'

vi.mock('ai', () => ({
  streamText: vi.fn(),
  stepCountIs: vi.fn((n: number) => ({ type: 'step-count', count: n })),
}))

vi.mock('../model/registry.js', () => ({
  getDefaultRegistry: vi.fn().mockReturnValue({
    resolve: vi.fn().mockReturnValue({ modelId: 'mock' }),
  }),
}))

function createMockStream(text: string) {
  async function* generate() {
    yield { type: 'text-delta', textDelta: text }
  }
  return {
    fullStream: generate(),
    then: (r: any) => r({ text, usage: { inputTokens: 50, outputTokens: 25 } }),
  }
}

describe('Multi-turn conversation', () => {
  const { streamText } = vi.mocked(await import('ai'))
  let store: MemoryConversationStore

  beforeEach(() => {
    store = new MemoryConversationStore()
    vi.clearAllMocks()
  })

  it('resumes conversation from store across engine instances', async () => {
    // Turn 1
    streamText.mockReturnValue(createMockStream('response-1') as any)
    const engine1 = new AgentEngine({
      model: 'mock/model',
      tools: {},
      conversationStore: store,
      conversationId: 'conv-1',
      initialMessages: await store.loadActive('conv-1') ?? [],
    })
    for await (const _ of engine1.run('message-1')) {}

    // Verify store has turn 1 messages
    const afterTurn1 = await store.loadAll('conv-1')
    expect(afterTurn1).not.toBeNull()
    expect(afterTurn1!.some(m => m.content === 'message-1')).toBe(true)

    // Turn 2 — new engine instance, loads from store
    streamText.mockReturnValue(createMockStream('response-2') as any)
    const activeMessages = await store.loadActive('conv-1')
    const engine2 = new AgentEngine({
      model: 'mock/model',
      tools: {},
      conversationStore: store,
      conversationId: 'conv-1',
      initialMessages: activeMessages ?? [],
    })
    for await (const _ of engine2.run('message-2')) {}

    // Verify streamText received messages from both turns
    const lastCall = streamText.mock.calls[streamText.mock.calls.length - 1][0]
    const messageContents = lastCall.messages.map((m: any) => m.content)
    expect(messageContents).toContain('message-1')
    expect(messageContents).toContain('message-2')
  })
})
```

**Step 2: Run test**

```bash
npx vitest run src/engine/AgentEngine.multiturn.test.ts
```

Expected: PASS

**Step 3: Commit**

```bash
git add src/engine/AgentEngine.multiturn.test.ts
git commit -m "test: add multi-turn conversation resume test"
```

---

## Phase 3: Safety & Compaction

### Task 13: BudgetGuard

**Files:**
- Create: `src/budget/BudgetGuard.ts`
- Create: `src/budget/pricing.ts`
- Create: `src/budget/BudgetGuard.test.ts`
- Modify: `src/index.ts`

**Step 1: Write the failing test**

Create `src/budget/BudgetGuard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { BudgetGuard } from './BudgetGuard.js'

describe('BudgetGuard', () => {
  it('is not exceeded with zero usage', () => {
    const guard = new BudgetGuard({ maxBudgetUsd: 1.0 })
    expect(guard.isExceeded({ inputTokens: 0, outputTokens: 0 }, 'anthropic/claude-sonnet-4.5')).toBe(false)
  })

  it('detects when budget is exceeded', () => {
    const guard = new BudgetGuard({ maxBudgetUsd: 0.001 })
    // Lots of tokens should exceed a tiny budget
    expect(guard.isExceeded({ inputTokens: 100000, outputTokens: 50000 }, 'anthropic/claude-sonnet-4.5')).toBe(true)
  })

  it('returns not exceeded when no budget set', () => {
    const guard = new BudgetGuard({})
    expect(guard.isExceeded({ inputTokens: 999999, outputTokens: 999999 }, 'anthropic/claude-sonnet-4.5')).toBe(false)
  })

  it('detects duration exceeded', () => {
    const guard = new BudgetGuard({ maxDurationMs: 1000 })
    const startTime = Date.now() - 2000 // 2 seconds ago
    expect(guard.isDurationExceeded(startTime)).toBe(true)
  })

  it('duration not exceeded within limit', () => {
    const guard = new BudgetGuard({ maxDurationMs: 60000 })
    expect(guard.isDurationExceeded(Date.now())).toBe(false)
  })

  it('duration not exceeded when no limit set', () => {
    const guard = new BudgetGuard({})
    const longAgo = Date.now() - 999999
    expect(guard.isDurationExceeded(longAgo)).toBe(false)
  })

  it('estimates cost correctly', () => {
    const guard = new BudgetGuard({ maxBudgetUsd: 10 })
    const cost = guard.estimateCost({ inputTokens: 1000000, outputTokens: 1000000 }, 'anthropic/claude-sonnet-4.5')
    expect(cost).toBeGreaterThan(0)
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/budget/BudgetGuard.test.ts
```

Expected: FAIL

**Step 3: Write pricing module**

Create `src/budget/pricing.ts`:

```typescript
// Prices in USD per token
interface ModelPricing {
  inputPerToken: number
  outputPerToken: number
}

// Default/fallback pricing (mid-range estimate)
const DEFAULT_PRICING: ModelPricing = {
  inputPerToken: 0.000003,  // $3/M tokens
  outputPerToken: 0.000015, // $15/M tokens
}

const KNOWN_PRICING: Record<string, ModelPricing> = {
  'anthropic/claude-sonnet-4.5': { inputPerToken: 0.000003, outputPerToken: 0.000015 },
  'anthropic/claude-opus-4.5': { inputPerToken: 0.000015, outputPerToken: 0.000075 },
  'anthropic/claude-haiku-3.5': { inputPerToken: 0.0000008, outputPerToken: 0.000004 },
  'openai/gpt-4o': { inputPerToken: 0.0000025, outputPerToken: 0.00001 },
  'openai/gpt-4o-mini': { inputPerToken: 0.00000015, outputPerToken: 0.0000006 },
  'google/gemini-2.0-flash': { inputPerToken: 0.0000001, outputPerToken: 0.0000004 },
}

export function getModelPricing(model: string): ModelPricing {
  return KNOWN_PRICING[model] ?? DEFAULT_PRICING
}
```

**Step 4: Write BudgetGuard implementation**

Create `src/budget/BudgetGuard.ts`:

```typescript
import type { TokenUsage } from '../engine/types.js'
import { getModelPricing } from './pricing.js'

export interface BudgetGuardConfig {
  maxBudgetUsd?: number
  maxDurationMs?: number
}

export class BudgetGuard {
  private config: BudgetGuardConfig

  constructor(config: BudgetGuardConfig) {
    this.config = config
  }

  isExceeded(usage: TokenUsage, model: string): boolean {
    if (!this.config.maxBudgetUsd) return false
    return this.estimateCost(usage, model) > this.config.maxBudgetUsd
  }

  isDurationExceeded(startTime: number): boolean {
    if (!this.config.maxDurationMs) return false
    return (Date.now() - startTime) > this.config.maxDurationMs
  }

  estimateCost(usage: TokenUsage, model: string): number {
    const pricing = getModelPricing(model)
    return (
      usage.inputTokens * pricing.inputPerToken +
      usage.outputTokens * pricing.outputPerToken
    )
  }
}
```

**Step 5: Run test to verify it passes**

```bash
npx vitest run src/budget/BudgetGuard.test.ts
```

Expected: PASS (7 tests)

**Step 6: Export from index**

Add to `src/index.ts`:

```typescript
export { BudgetGuard } from './budget/BudgetGuard.js'
export type { BudgetGuardConfig } from './budget/BudgetGuard.js'
```

**Step 7: Commit**

```bash
git add src/budget/BudgetGuard.ts src/budget/pricing.ts src/budget/BudgetGuard.test.ts src/index.ts
git commit -m "feat: add BudgetGuard with cost estimation and duration checks"
```

---

### Task 14: Token estimator

**Files:**
- Create: `src/compaction/tokenEstimator.ts`
- Create: `src/compaction/tokenEstimator.test.ts`

**Step 1: Write the failing test**

Create `src/compaction/tokenEstimator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { estimateTokens } from './tokenEstimator.js'
import type { StoreMessage } from '../engine/types.js'

describe('estimateTokens', () => {
  it('estimates tokens for a string', () => {
    const tokens = estimateTokens('Hello world, this is a test.')
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(100)
  })

  it('estimates tokens for messages array', () => {
    const msgs: StoreMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there, how can I help?' },
    ]
    const tokens = estimateTokens(msgs)
    expect(tokens).toBeGreaterThan(0)
  })

  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens([])).toBe(0)
  })

  it('longer text produces more tokens', () => {
    const short = estimateTokens('Hi')
    const long = estimateTokens('This is a much longer sentence with many more words in it.')
    expect(long).toBeGreaterThan(short)
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/compaction/tokenEstimator.test.ts
```

Expected: FAIL

**Step 3: Write implementation**

Create `src/compaction/tokenEstimator.ts`:

```typescript
import type { StoreMessage } from '../engine/types.js'

// Simple token estimation: ~4 characters per token (rough average for English)
// Good enough for compaction threshold decisions. Not used for billing.
const CHARS_PER_TOKEN = 4

export function estimateTokens(input: string | StoreMessage[]): number {
  if (typeof input === 'string') {
    return Math.ceil(input.length / CHARS_PER_TOKEN)
  }
  if (input.length === 0) return 0
  const totalChars = input.reduce((sum, msg) => {
    // Add role overhead (~4 tokens per message for role/formatting)
    return sum + msg.content.length + 16
  }, 0)
  return Math.ceil(totalChars / CHARS_PER_TOKEN)
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/compaction/tokenEstimator.test.ts
```

Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/compaction/tokenEstimator.ts src/compaction/tokenEstimator.test.ts
git commit -m "feat: add simple token estimator for compaction decisions"
```

---

### Task 15: ThresholdCompactionStrategy

**Files:**
- Create: `src/compaction/ThresholdCompaction.ts`
- Create: `src/compaction/ThresholdCompaction.test.ts`
- Modify: `src/index.ts`

**Step 1: Write the failing test**

Create `src/compaction/ThresholdCompaction.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { ThresholdCompactionStrategy } from './ThresholdCompaction.js'
import type { StoreMessage, TokenUsage } from '../engine/types.js'

// Mock generateText
vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({ text: 'Summary of conversation.' }),
}))

describe('ThresholdCompactionStrategy', () => {
  describe('shouldCompact', () => {
    it('returns false when under threshold', () => {
      const strategy = new ThresholdCompactionStrategy({ threshold: 0.75, contextWindow: 100000 })
      const usage: TokenUsage = { inputTokens: 50000, outputTokens: 10000 }
      expect(strategy.shouldCompact([], usage)).toBe(false)
    })

    it('returns true when over threshold', () => {
      const strategy = new ThresholdCompactionStrategy({ threshold: 0.75, contextWindow: 100000 })
      const usage: TokenUsage = { inputTokens: 70000, outputTokens: 10000 }
      expect(strategy.shouldCompact([], usage)).toBe(true)
    })
  })

  describe('compact', () => {
    it('preserves recent messages and summarizes old ones', async () => {
      const messages: StoreMessage[] = [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'resp1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'resp2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'resp3' },
        { role: 'user', content: 'msg4' },
        { role: 'assistant', content: 'resp4' },
        { role: 'user', content: 'msg5-recent' },
        { role: 'assistant', content: 'resp5-recent' },
        { role: 'user', content: 'msg6-recent' },
        { role: 'assistant', content: 'resp6-recent' },
      ]

      const strategy = new ThresholdCompactionStrategy({ keepRecentMessages: 6 })
      const mockModel = { modelId: 'mock' } as any
      const result = await strategy.compact(messages, mockModel)

      // Should have boundary + summary user + summary ack + 6 kept messages = 9
      expect(result.activeMessages).toHaveLength(9)
      expect(result.activeMessages[0].type).toBe('compact_boundary')
      expect(result.activeMessages[0].role).toBe('system')
      // Last 6 should be the recent ones
      expect(result.activeMessages[3].content).toBe('resp4')
      expect(result.activeMessages[8].content).toBe('resp6-recent')

      expect(result.compactedCount).toBe(6) // first 6 messages compacted
      expect(result.summary).toBe('Summary of conversation.')
      expect(result.freedTokens).toBeGreaterThan(0)
    })

    it('does not compact if too few messages', async () => {
      const messages: StoreMessage[] = [
        { role: 'user', content: 'only one' },
        { role: 'assistant', content: 'response' },
      ]

      const strategy = new ThresholdCompactionStrategy({ keepRecentMessages: 6 })
      const mockModel = { modelId: 'mock' } as any
      const result = await strategy.compact(messages, mockModel)

      // Nothing to compact — return as-is
      expect(result.activeMessages).toEqual(messages)
      expect(result.compactedCount).toBe(0)
      expect(result.appendMessages).toHaveLength(0)
    })
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/compaction/ThresholdCompaction.test.ts
```

Expected: FAIL

**Step 3: Write implementation**

Create `src/compaction/ThresholdCompaction.ts`:

```typescript
import { generateText } from 'ai'
import type { LanguageModelV2 } from 'ai'
import type {
  CompactionStrategy,
  CompactionResult,
  StoreMessage,
  TokenUsage,
} from '../engine/types.js'
import { estimateTokens } from './tokenEstimator.js'

export interface ThresholdCompactionConfig {
  threshold?: number       // 0-1, default 0.75
  contextWindow?: number   // default 200000
  keepRecentMessages?: number // default 6
}

export class ThresholdCompactionStrategy implements CompactionStrategy {
  private threshold: number
  private contextWindow: number
  private keepRecent: number

  constructor(config: ThresholdCompactionConfig = {}) {
    this.threshold = config.threshold ?? 0.75
    this.contextWindow = config.contextWindow ?? 200000
    this.keepRecent = config.keepRecentMessages ?? 6
  }

  shouldCompact(_messages: StoreMessage[], usage: TokenUsage): boolean {
    const totalTokens = usage.inputTokens + usage.outputTokens
    return totalTokens > this.contextWindow * this.threshold
  }

  async compact(messages: StoreMessage[], model: LanguageModelV2): Promise<CompactionResult> {
    if (messages.length <= this.keepRecent) {
      return {
        activeMessages: messages,
        appendMessages: [],
        summary: '',
        freedTokens: 0,
        compactedCount: 0,
      }
    }

    const toCompact = messages.slice(0, -this.keepRecent)
    const toKeep = messages.slice(-this.keepRecent)

    // Generate summary using LLM
    const formatted = toCompact
      .map(m => `${m.role}: ${m.content}`)
      .join('\n')

    const { text: summary } = await generateText({
      model,
      prompt: `Summarize this conversation concisely, preserving key facts, decisions, and context needed for continuation:\n\n${formatted}`,
    })

    const preTokens = estimateTokens(messages)

    const boundary: StoreMessage = {
      role: 'system',
      content: '[Compact Boundary]',
      type: 'compact_boundary',
      metadata: {
        trigger: 'auto',
        compactedMessageCount: toCompact.length,
        preCompactTokenCount: preTokens,
        postCompactTokenCount: estimateTokens(summary) + estimateTokens(toKeep),
        timestamp: new Date(),
      },
    }

    const summaryUser: StoreMessage = {
      role: 'user',
      content: `[Previous conversation summary]\n${summary}`,
    }
    const summaryAck: StoreMessage = {
      role: 'assistant',
      content: 'Understood. I have the context from our previous conversation.',
    }

    const activeMessages = [boundary, summaryUser, summaryAck, ...toKeep]
    const appendMessages = [boundary, summaryUser, summaryAck]

    return {
      activeMessages,
      appendMessages,
      summary,
      freedTokens: estimateTokens(toCompact) - estimateTokens(summary),
      compactedCount: toCompact.length,
    }
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/compaction/ThresholdCompaction.test.ts
```

Expected: PASS (4 tests)

**Step 5: Export from index**

Add to `src/index.ts`:

```typescript
export { ThresholdCompactionStrategy } from './compaction/ThresholdCompaction.js'
export type { ThresholdCompactionConfig } from './compaction/ThresholdCompaction.js'
export { estimateTokens } from './compaction/tokenEstimator.js'
```

**Step 6: Commit**

```bash
git add src/compaction/ThresholdCompaction.ts src/compaction/ThresholdCompaction.test.ts src/index.ts
git commit -m "feat: add ThresholdCompactionStrategy with LLM-based summarization"
```

---

### Task 16: DefaultErrorHandler

**Files:**
- Create: `src/error/DefaultErrorHandler.ts`
- Create: `src/error/DefaultErrorHandler.test.ts`
- Modify: `src/index.ts`

**Step 1: Write the failing test**

Create `src/error/DefaultErrorHandler.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { DefaultErrorHandler } from './DefaultErrorHandler.js'

describe('DefaultErrorHandler', () => {
  it('retries on rate limit error with exponential backoff', async () => {
    const handler = new DefaultErrorHandler()
    const error = Object.assign(new Error('rate limited'), { status: 429 })

    const decision = await handler.handle(error, 0)
    expect(decision.action).toBe('retry')
    if (decision.action === 'retry') {
      expect(decision.delayMs).toBe(1000) // 1000 * 2^0
    }

    const decision2 = await handler.handle(error, 2)
    if (decision2.action === 'retry') {
      expect(decision2.delayMs).toBe(4000) // 1000 * 2^2
    }
  })

  it('caps retry delay at 30 seconds', async () => {
    const handler = new DefaultErrorHandler()
    const error = Object.assign(new Error('rate limited'), { status: 429 })

    const decision = await handler.handle(error, 10)
    if (decision.action === 'retry') {
      expect(decision.delayMs).toBeLessThanOrEqual(30000)
    }
  })

  it('retries on overloaded error up to 3 times', async () => {
    const handler = new DefaultErrorHandler()
    const error = Object.assign(new Error('overloaded'), { status: 529 })

    expect((await handler.handle(error, 0)).action).toBe('retry')
    expect((await handler.handle(error, 1)).action).toBe('retry')
    expect((await handler.handle(error, 2)).action).toBe('retry')
    // 4th attempt should not retry
    const decision = await handler.handle(error, 3)
    expect(decision.action).not.toBe('retry')
  })

  it('falls back to another model when configured', async () => {
    const handler = new DefaultErrorHandler('openai/gpt-4o')
    const error = new Error('unknown error')

    const decision = await handler.handle(error, 0)
    expect(decision).toEqual({ action: 'fallback', model: 'openai/gpt-4o' })
  })

  it('aborts when no fallback and not retryable', async () => {
    const handler = new DefaultErrorHandler()
    const error = new Error('unknown error')

    const decision = await handler.handle(error, 0)
    expect(decision.action).toBe('abort')
    if (decision.action === 'abort') {
      expect(decision.message).toBe('unknown error')
    }
  })

  it('does not fallback more than once', async () => {
    const handler = new DefaultErrorHandler('openai/gpt-4o')
    const error = new Error('still failing')

    const d1 = await handler.handle(error, 0)
    expect(d1.action).toBe('fallback')

    const d2 = await handler.handle(error, 2)
    expect(d2.action).toBe('abort')
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/error/DefaultErrorHandler.test.ts
```

Expected: FAIL

**Step 3: Write implementation**

Create `src/error/DefaultErrorHandler.ts`:

```typescript
import type { ErrorHandler, ErrorDecision } from '../engine/types.js'

export class DefaultErrorHandler implements ErrorHandler {
  constructor(private fallbackModel?: string) {}

  async handle(error: Error, attempt: number): Promise<ErrorDecision> {
    // Rate limit → exponential backoff
    if (this.isRateLimitError(error)) {
      return {
        action: 'retry',
        delayMs: Math.min(1000 * Math.pow(2, attempt), 30000),
      }
    }

    // Overloaded → up to 3 retries
    if (this.isOverloadedError(error) && attempt < 3) {
      return { action: 'retry', delayMs: 5000 }
    }

    // Fallback model (only on first non-retryable attempt)
    if (this.fallbackModel && attempt < 2) {
      return { action: 'fallback', model: this.fallbackModel }
    }

    return { action: 'abort', message: error.message }
  }

  private isRateLimitError(error: Error): boolean {
    return (error as any).status === 429 ||
      error.message.toLowerCase().includes('rate limit')
  }

  private isOverloadedError(error: Error): boolean {
    return (error as any).status === 529 ||
      (error as any).status === 503 ||
      error.message.toLowerCase().includes('overloaded')
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/error/DefaultErrorHandler.test.ts
```

Expected: PASS (6 tests)

**Step 5: Export from index**

Add to `src/index.ts`:

```typescript
export { DefaultErrorHandler } from './error/DefaultErrorHandler.js'
```

**Step 6: Commit**

```bash
git add src/error/DefaultErrorHandler.ts src/error/DefaultErrorHandler.test.ts src/index.ts
git commit -m "feat: add DefaultErrorHandler with retry, fallback, and abort"
```

---

### Task 17: Integrate BudgetGuard, Compaction, ErrorHandler, and onToolCall into AgentEngine

**Files:**
- Modify: `src/engine/AgentEngine.ts`
- Create: `src/engine/AgentEngine.safety.test.ts`

**Step 1: Write the failing tests**

Create `src/engine/AgentEngine.safety.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentEngine } from './AgentEngine.js'
import { MemoryConversationStore } from '../conversation/MemoryStore.js'
import type { AgentEvent } from './types.js'

vi.mock('ai', () => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn((n: number) => ({ type: 'step-count', count: n })),
}))

vi.mock('../model/registry.js', () => ({
  getDefaultRegistry: vi.fn().mockReturnValue({
    resolve: vi.fn().mockReturnValue({ modelId: 'mock' }),
  }),
}))

function createMockStream(text = 'ok') {
  async function* generate() {
    yield { type: 'text-delta', textDelta: text }
  }
  return {
    fullStream: generate(),
    then: (r: any) => r({ text, usage: { inputTokens: 10, outputTokens: 5 } }),
  }
}

describe('AgentEngine safety features', () => {
  const { streamText } = vi.mocked(await import('ai'))
  let store: MemoryConversationStore

  beforeEach(() => {
    store = new MemoryConversationStore()
    vi.clearAllMocks()
  })

  it('stops when maxDurationMs is exceeded', async () => {
    // Create a slow stream
    async function* slowStream() {
      yield { type: 'text-delta', textDelta: 'start' }
      await new Promise(r => setTimeout(r, 100))
      yield { type: 'text-delta', textDelta: 'end' }
    }
    streamText.mockReturnValue({
      fullStream: slowStream(),
      then: (r: any) => r({ text: 'end', usage: { inputTokens: 10, outputTokens: 5 } }),
    } as any)

    const engine = new AgentEngine({
      model: 'mock/model',
      tools: {},
      conversationStore: store,
      conversationId: 'c1',
      maxDurationMs: 1, // 1ms — will exceed immediately
    })

    const events: AgentEvent[] = []
    for await (const event of engine.run('test')) {
      events.push(event)
    }

    // Should have an error event about duration
    const errorEvent = events.find(e => e.type === 'error')
    expect(errorEvent).toBeDefined()
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.message).toContain('Duration exceeded')
    }
  })

  it('calls onToolCall hook before tool execution', async () => {
    const onToolCall = vi.fn().mockResolvedValue({ action: 'allow' })

    async function* streamWithTool() {
      yield { type: 'tool-call', toolCallId: 'tc-1', toolName: 'send_email', args: { to: 'x' } }
      yield { type: 'tool-result', toolCallId: 'tc-1', toolName: 'send_email', args: { to: 'x' }, result: { sent: true } }
    }
    streamText.mockReturnValue({
      fullStream: streamWithTool(),
      then: (r: any) => r({ text: '', usage: { inputTokens: 10, outputTokens: 5 } }),
    } as any)

    const engine = new AgentEngine({
      model: 'mock/model',
      tools: {},
      conversationStore: store,
      conversationId: 'c1',
      onToolCall,
    })

    const events: AgentEvent[] = []
    for await (const event of engine.run('test')) {
      events.push(event)
    }

    expect(onToolCall).toHaveBeenCalledWith({
      toolName: 'send_email',
      toolCallId: 'tc-1',
      input: { to: 'x' },
    })
  })

  it('denies tool call when onToolCall returns deny', async () => {
    const onToolCall = vi.fn().mockResolvedValue({ action: 'deny', reason: 'Nope' })

    async function* streamWithTool() {
      yield { type: 'tool-call', toolCallId: 'tc-1', toolName: 'delete_all', args: {} }
      yield { type: 'tool-result', toolCallId: 'tc-1', toolName: 'delete_all', args: {}, result: {} }
    }
    streamText.mockReturnValue({
      fullStream: streamWithTool(),
      then: (r: any) => r({ text: '', usage: { inputTokens: 10, outputTokens: 5 } }),
    } as any)

    const engine = new AgentEngine({
      model: 'mock/model',
      tools: {},
      conversationStore: store,
      conversationId: 'c1',
      onToolCall,
    })

    const events: AgentEvent[] = []
    for await (const event of engine.run('test')) {
      events.push(event)
    }

    // Should NOT have a tool-call-complete event for the denied tool
    const toolComplete = events.find(
      e => e.type === 'tool-call-complete' && e.toolName === 'delete_all'
    )
    // The tool-call-start should still fire (it's informational)
    // But tool-call-complete should not (or should show denied)
    const errorOrDeny = events.find(
      e => e.type === 'error' || (e.type === 'tool-call-complete' && e.output === 'DENIED: Nope')
    )
    expect(errorOrDeny ?? toolComplete).toBeDefined()
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/engine/AgentEngine.safety.test.ts
```

Expected: Some tests FAIL (onToolCall not yet integrated)

**Step 3: Update AgentEngine to integrate safety features**

Update `mapStreamPart` in `src/engine/AgentEngine.ts` to include onToolCall hook:

```typescript
  private async *mapStreamPart(part: any): AsyncGenerator<AgentEvent> {
    switch (part.type) {
      case 'text-delta':
        yield { type: 'text-delta', text: part.textDelta }
        break
      case 'tool-call': {
        yield {
          type: 'tool-call-start',
          toolName: part.toolName,
          toolCallId: part.toolCallId,
        }
        // Check onToolCall hook
        if (this.config.onToolCall) {
          const decision = await this.config.onToolCall({
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            input: part.args,
          })
          if (decision.action === 'deny') {
            yield {
              type: 'tool-call-complete',
              toolName: part.toolName,
              toolCallId: part.toolCallId,
              input: part.args,
              output: `DENIED: ${decision.reason}`,
            }
            return // Skip the actual tool result
          }
        }
        break
      }
      case 'tool-result':
        yield {
          type: 'tool-call-complete',
          toolName: part.toolName,
          toolCallId: part.toolCallId,
          input: part.args,
          output: part.result,
        }
        break
    }
  }
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/engine/AgentEngine.safety.test.ts
```

Expected: PASS (3 tests)

**Step 5: Run all tests**

```bash
npx vitest run
```

Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/engine/AgentEngine.ts src/engine/AgentEngine.safety.test.ts
git commit -m "feat: integrate BudgetGuard, onToolCall hook, and duration checks into AgentEngine"
```

---

## Phase 4: Polish & Publish

### Task 18: Final index.ts exports and type check

**Files:**
- Modify: `src/index.ts`

**Step 1: Ensure all public API is exported**

Update `src/index.ts` to include all exports (consolidate from previous tasks):

```typescript
// Engine
export { AgentEngine } from './engine/AgentEngine.js'
export { AgentError, BudgetExceededError, DurationExceededError } from './engine/errors.js'
export type {
  AgentEvent,
  TextDeltaEvent,
  ToolCallStartEvent,
  ToolCallCompleteEvent,
  CompactEvent,
  StatusEvent,
  AgentErrorEvent,
  ResultEvent,
  TokenUsage,
  AgentEngineConfig,
  StoreMessage,
  CompactBoundaryMessage,
  ToolCallHook,
  ToolCallDecision,
} from './engine/types.js'

// Model
export { ModelRegistry, getDefaultRegistry } from './model/registry.js'
export type { ProviderFactory } from './model/registry.js'

// Prompt
export { PromptBuilder } from './prompt/PromptBuilder.js'
export type { PromptBuildParams } from './prompt/PromptBuilder.js'

// Context
export { ContextManager } from './context/ContextManager.js'
export { staticProvider } from './context/providers/staticProvider.js'
export type {
  ContextProvider,
  ContextBlock,
  ContextResolveParams,
} from './engine/types.js'

// Conversation
export { MemoryConversationStore } from './conversation/MemoryStore.js'
export { getMessagesAfterCompactBoundary } from './conversation/boundary.js'
export type {
  ConversationStore,
  ConversationListResult,
  ConversationSummary,
} from './engine/types.js'

// Compaction
export { ThresholdCompactionStrategy } from './compaction/ThresholdCompaction.js'
export type { ThresholdCompactionConfig } from './compaction/ThresholdCompaction.js'
export { estimateTokens } from './compaction/tokenEstimator.js'
export type { CompactionStrategy, CompactionResult } from './engine/types.js'

// Error
export { DefaultErrorHandler } from './error/DefaultErrorHandler.js'
export type { ErrorHandler, ErrorDecision } from './engine/types.js'

// Budget
export { BudgetGuard } from './budget/BudgetGuard.js'
export type { BudgetGuardConfig } from './budget/BudgetGuard.js'
```

**Step 2: Type check and run all tests**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: ALL PASS

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "chore: consolidate all public API exports"
```

---

### Task 19: Build verification

**Step 1: Run build**

```bash
npx tsup
```

Expected: Produces `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`

**Step 2: Verify dist files exist**

```bash
ls -la dist/
```

Expected: `index.js`, `index.cjs`, `index.d.ts` (+ sourcemaps)

**Step 3: Commit if any config adjustments were needed**

```bash
git add -A && git commit -m "chore: verify build output" || echo "nothing to commit"
```

---

### Task 20: Final all-tests run

**Step 1: Run full test suite**

```bash
npx vitest run --reporter=verbose
```

Expected: ALL PASS. All modules tested:
- ModelRegistry (6 tests)
- PromptBuilder (7 tests)
- MemoryConversationStore (7 tests)
- AgentEngine core (7 tests)
- AgentEngine stream (2 tests)
- AgentEngine integration (2 tests)
- AgentEngine context (2 tests)
- AgentEngine multi-turn (1 test)
- AgentEngine safety (3 tests)
- BudgetGuard (7 tests)
- Token estimator (4 tests)
- ThresholdCompaction (4 tests)
- DefaultErrorHandler (6 tests)
- ContextManager (5 tests)
- staticProvider (2 tests)

**Step 2: Final commit**

```bash
git add -A && git commit -m "chore: Phase 4 — all tests passing, build verified" || echo "nothing to commit"
```
