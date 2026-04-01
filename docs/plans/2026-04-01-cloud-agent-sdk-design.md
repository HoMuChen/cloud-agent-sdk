# Cloud Agent SDK — Design Document

> Approved: 2026-04-01
> Package name: `cloud-agent-sdk`
> Based on: `AGENT_FRAMEWORK_DESIGN.md`

---

## 1. Overview

A TypeScript SDK that wraps Vercel AI SDK to provide an opinionated agentic loop for cloud applications. Turns existing business APIs into AI-powered conversational tools.

**Key decisions from brainstorming:**

| Decision | Choice |
|----------|--------|
| Package name | `cloud-agent-sdk` (unscoped) |
| Model config | String format `'anthropic/claude-sonnet-4.5'` with internal registry |
| Primary use case | Internal product — adding AI conversation to existing API |
| AI SDK API | Verify against latest docs before implementation |
| Testing | Unit tests only, mock AI SDK, no LLM API calls |
| Frontend | AI SDK `useChat` — `toUIMessageStreamResponse()` is core |
| Runtime | Self-managed Node.js server (Express/Hono/Fastify) |

---

## 2. Architecture

```
Your Application (any runtime: HTTP / CLI / Cron / Queue)
    ↓
cloud-agent-sdk (AgentEngine)
    ↓
Vercel AI SDK (streamText / generateText)
    ↓
Any LLM Provider (Anthropic / OpenAI / Google / ...)
```

### AgentEngine

Short-lived instance — construct, run, destroy. No state survives across invocations. `ConversationStore` is the single source of truth.

**Three consumption modes:**

1. `run(input)` — `AsyncGenerator<AgentEvent>`, core API, works in any runtime
2. `toUIMessageStreamResponse(input)` — HTTP streaming, frontend `useChat` compatible
3. `generate(input)` — Non-streaming, for cron/webhook/programmatic use

### Model Registry

Accepts string format, resolves internally to AI SDK provider instances:

- `anthropic/*` → `@ai-sdk/anthropic`
- `openai/*` → `@ai-sdk/openai`
- `google/*` → `@ai-sdk/google`

Provider packages are **peer dependencies** — users install only what they need. Missing provider → clear error message.

Users can register custom providers via registry API.

---

## 3. Conversation Management & Persistence

### ConversationStore Interface

Append-only. Three core methods + one optional:

- `append(conversationId, messages)` — Append, never overwrite
- `loadAll(conversationId)` — Full history (frontend rendering)
- `loadActive(conversationId)` — Messages after last compact boundary (Engine init)
- `list?(userId, options)` — Optional, list conversations

### Built-in: MemoryConversationStore

In-memory Map. Suitable for dev/test/CLI single-session.

### Immediate Persistence

- User message → append immediately (survives interruption)
- Assistant message / tool result → append as soon as complete (no batching)
- Rationale: process may be killed at any time

### Compact Boundary

Special system message marking compaction points. Contains metadata (compacted count, pre/post token counts). `loadActive()` finds last boundary, returns only messages after it.

---

## 4. Context Provider & System Prompt Assembly

### ContextProvider Interface

- Resolved in parallel via `Promise.all()` at start of each `run()`
- Returns `ContextBlock` with `placement: 'system' | 'user-prefix'`
- No SDK-level caching — users implement their own (Redis etc.)
- Provider errors → log warning, skip (don't crash engine)

### PromptBuilder — 5 Layers

1. **Role definition** — `systemPrompt` (static)
2. **Tool guidance** — Auto-generated from registered tools
3. **Context provider results** — Dynamic, `placement: 'system'` blocks
4. **Additional instructions** — `instructions[]`
5. **Guardrail instructions** — Auto-injected based on config

`placement: 'user-prefix'` context is prepended to user message, not system prompt.

### Built-in Provider

`staticProvider(name, content, placement)` — Simple static context for quick use.

---

## 5. Compaction, Budget Guard & Error Recovery

### CompactionStrategy

- `shouldCompact(messages, usage)` — Check if compaction needed
- `compact(messages, model)` — Execute compaction

**Default: ThresholdCompactionStrategy**
- Triggers at 75% context window usage
- Keeps last 6 messages (3 turns) uncompacted
- Uses LLM `generateText()` to summarize compacted portion
- Checked after every agentic step

### BudgetGuard — 3 Rails

- `maxSteps` — Default 25, via AI SDK `stopWhen: stepCountIs()`
- `maxBudgetUsd` — Checked per stream part
- `maxDurationMs` — Checked per stream part

Exceeding any limit → yield `{ type: 'error', recoverable: false }`, then return.

### ErrorHandler

- Rate limit → exponential backoff retry
- Overloaded → up to 3 retries
- Other error + fallback model → switch model and retry
- All fail → abort

### onToolCall Interceptor

- Called before each tool execution
- Returns `{ action: 'allow' }` or `{ action: 'deny', reason }`
- Permission logic belongs to application layer

---

## 6. Project Structure

```
cloud-agent-sdk/
├── src/
│   ├── index.ts                  # Public API exports
│   ├── engine/
│   │   ├── AgentEngine.ts        # Core engine (~300 lines)
│   │   ├── types.ts              # AgentEvent, AgentEngineConfig, TokenUsage
│   │   └── errors.ts             # AgentError, BudgetExceededError
│   ├── prompt/
│   │   ├── PromptBuilder.ts      # System prompt layered assembly
│   │   └── toolGuidance.ts       # Auto-generated tool usage guidance
│   ├── context/
│   │   ├── types.ts              # ContextProvider, ContextBlock
│   │   ├── ContextManager.ts     # Parallel resolve all providers
│   │   └── providers/
│   │       └── staticProvider.ts
│   ├── compaction/
│   │   ├── types.ts              # CompactionStrategy
│   │   ├── ThresholdCompaction.ts
│   │   └── tokenEstimator.ts
│   ├── conversation/
│   │   ├── types.ts              # ConversationStore, CompactBoundaryMessage
│   │   ├── MemoryStore.ts
│   │   ├── boundary.ts           # getMessagesAfterCompactBoundary()
│   │   └── serialization.ts
│   ├── error/
│   │   ├── types.ts              # ErrorHandler, ErrorDecision
│   │   └── DefaultErrorHandler.ts
│   ├── budget/
│   │   ├── BudgetGuard.ts
│   │   └── pricing.ts
│   └── model/
│       ├── registry.ts           # String → provider instance resolution
│       └── providers.ts          # Built-in provider mappings
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 7. Tech Stack

| Dependency | Role | Type |
|-----------|------|------|
| `ai` | Vercel AI SDK | direct |
| `zod` | Tool schema validation | direct (via ai) |
| `@ai-sdk/anthropic` | Anthropic provider | peer |
| `@ai-sdk/openai` | OpenAI provider | peer |
| `@ai-sdk/google` | Google provider | peer |
| `vitest` | Unit testing | dev |
| `tsup` | ESM + CJS build | dev |
| `typescript` | Type system | dev |

---

## 8. Testing Strategy

Unit tests only. Mock `streamText` / `generateText` from AI SDK.

**Per-module tests:**
- `PromptBuilder` — verify 5-layer assembly
- `ContextManager` — parallel resolve, error handling, null skip
- `MemoryConversationStore` — append, loadAll, loadActive, boundary handling
- `BudgetGuard` — maxSteps, maxBudgetUsd, maxDurationMs checks
- `ThresholdCompaction` — shouldCompact threshold, compact result structure
- `DefaultErrorHandler` — rate limit retry, overload retry, model fallback, abort
- `ModelRegistry` — string parsing, provider resolution, missing provider error
- `AgentEngine` — full loop with mock stream, multi-turn, event mapping

---

## 9. Implementation Phases

### Phase 1: Core Loop
- AgentEngine + `run()` AsyncGenerator
- PromptBuilder basic assembly
- AI SDK `streamText` + `stopWhen: stepCountIs()` agentic loop
- AgentEvent types + stream mapping
- `toUIMessageStreamResponse()`
- Model registry (string → provider)
- MemoryConversationStore (needed for Phase 1 validation)

### Phase 2: Context & Conversation
- ContextProvider + ContextManager
- ConversationStore interface refinement
- CompactBoundaryMessage + `getMessagesAfterCompactBoundary()`
- Immediate persistence (per-message append)
- Multi-turn conversation resume
- `loadAll()` with boundary markers

### Phase 3: Safety & Compaction
- BudgetGuard (steps, USD, duration)
- CompactionStrategy + ThresholdCompaction
- Token estimator
- ErrorHandler + retry / model fallback
- onToolCall interceptor
- abortSignal support

### Phase 4: Polish & Publish
- TypeScript types refinement
- ESM + CJS output
- JSDoc
- Edge case handling
- npm publish

---

## 10. Out of Scope

- Local file operations
- Prompt caching
- UI rendering
- Permission UI
- Agent-to-agent communication
- Plugin system
- Runtime-specific adapters (Express middleware, Next.js route handler, etc.)
