# Cloud Agent SDK — Design Guidelines & Implementation Plan

> 基於 Claude Code 架構分析，改用 Vercel AI SDK，設計一個雲端 Agent Framework。
> 目標：為既有 API 加上 AI 對話能力，API 的系統、資料、用戶知識作為 tools 裝載。

---

## 1. 架構總覽

```
┌─────────────────────────────────────────────────────────┐
│                    Your Application                      │
│  (Next.js API Route / Express / Hono / ...)             │
├─────────────────────────────────────────────────────────┤
│                   Cloud Agent SDK                        │
│  ┌───────────────────────────────────────────────────┐  │
│  │  AgentEngine (per-invocation lifecycle)             │  │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────────────┐  │  │
│  │  │ Prompt  │ │ Context  │ │ Conversation      │  │  │
│  │  │ Builder │ │ Manager  │ │ Store (pluggable) │  │  │
│  │  └─────────┘ └──────────┘ └───────────────────┘  │  │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────────────┐  │  │
│  │  │ Tool    │ │ Budget   │ │ Event             │  │  │
│  │  │Registry │ │ Guard    │ │ Emitter           │  │  │
│  │  └─────────┘ └──────────┘ └───────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│              Vercel AI SDK (streamText / generateText)   │
├──────────┬──────────┬───────────────────────────────────┤
│ Anthropic│  OpenAI  │  Google  │  Any Provider          │
└──────────┴──────────┴───────────────────────────────────┘
```

### 與 Claude Code 的差異

| 面向 | Claude Code | Cloud Agent SDK |
|------|-------------|-----------------|
| 運行環境 | 本地 CLI | 任意（HTTP server / CLI / cron / queue consumer）|
| LLM 通訊 | 直接 Anthropic SDK | Vercel AI SDK（multi-provider）|
| 檔案存取 | 本地 fs (Read/Write/Edit/Bash) | 無，業務 API 作為 tools |
| Permission | 即時 prompt user | Application 層處理 |
| Prompt caching | Anthropic 原生 | 不需要 |
| 對話儲存 | 本地 JSON transcript | 可插拔 store（DB / Redis / Memory）|
| Context 注入 | CLAUDE.md + git status | 可插拔 providers |

---

## 2. 核心設計準則

### 準則 1：AsyncGenerator 作為統一訊息協定

從 Claude Code 學到的最重要設計。`AgentEngine.run()` 回傳 `AsyncGenerator<AgentEvent>`：

```typescript
// 核心介面
interface AgentEngine {
  run(input: string | ContentPart[]): AsyncGenerator<AgentEvent>
}

// 統一事件型別（discriminated union）
type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-start'; toolName: string; toolCallId: string }
  | { type: 'tool-call-complete'; toolName: string; toolCallId: string; input: unknown; output: unknown }
  | { type: 'compact'; freedTokens: number; summary: string; compactedCount: number }
  | { type: 'status'; message: string }
  | { type: 'error'; error: Error; recoverable: boolean }
  | { type: 'result'; text: string; usage: TokenUsage; durationMs: number }
```

**為什麼不直接暴露 AI SDK 的 stream？**
因為 AgentEngine 要在 AI SDK 的事件之上加：
- Budget 檢查事件
- Context compaction 事件
- 自定義 status 事件
- Error recovery 事件

框架消費者只看 `AgentEvent`，不需要知道底層用哪個 LLM。

### 準則 2：Engine 是短命的 — 建構、執行、銷毀

Engine 不假設任何特定的 runtime。每次呼叫 `run()` 都遵循同一個生命週期：

```
任何呼叫方（HTTP / CLI / Cron / Queue）
    ↓
  store.loadActive(conversationId)  ← 從 store 載入 active messages
    ↓
  new AgentEngine({ initialMessages })  ← 建立 engine
    ↓
  engine.run(userInput)  ← 執行 turn（內部即時 persist）
    ↓
  消費完 AsyncGenerator  ← 呼叫方決定怎麼用（串流回 HTTP / 印到 terminal / 寫入檔案）
    ↓
  Engine 被 GC  ← 銷毀
```

**三種 runtime 的用法：**

```typescript
// ─── HTTP API Route ───
export async function POST(req: Request) {
  const { message, conversationId } = await req.json()
  const engine = createEngine(conversationId, { abortSignal: req.signal })
  return engine.toUIMessageStreamResponse(message)
}

// ─── CLI ───
const conversationId = process.argv[2] ?? crypto.randomUUID()
const engine = await createEngine(conversationId)
for await (const event of engine.run(prompt)) {
  if (event.type === 'text-delta') process.stdout.write(event.text)
}

// ─── Cron / Queue Consumer ───
async function handleJob(job: { conversationId: string; message: string }) {
  const engine = await createEngine(job.conversationId)
  const result = await engine.generate(job.message)  // 非串流，等完整結果
  await saveResult(job.conversationId, result)
}

// 共用的 engine factory
async function createEngine(conversationId: string, opts?: { abortSignal?: AbortSignal }) {
  const store = new PostgresConversationStore(db)
  return new AgentEngine({
    model: 'anthropic/claude-sonnet-4.5',
    tools: createBusinessTools(apiClient),
    conversationStore: store,
    conversationId,
    initialMessages: await store.loadActive(conversationId) ?? [],
    abortSignal: opts?.abortSignal,
  })
}
```

**Engine 不保留跨 invocation 的狀態。** `this.messages` 只在單次 `run()` 的生命週期內有意義：
- 建構時從 store 載入
- 執行中累積新訊息（即時 persist）
- `run()` 結束後可被 GC

### 準則 3：所有外部依賴都是可插拔的

```typescript
interface AgentEngineConfig {
  // === 必要 ===
  model: string                           // e.g. 'anthropic/claude-sonnet-4.5'
  tools: Record<string, Tool>             // 你的業務 API tools

  // === System Prompt 組裝 ===
  systemPrompt?: string                   // 固定的角色定義
  contextProviders?: ContextProvider[]     // 動態 context 注入（見準則 4）
  instructions?: string[]                 // 額外指令（可插拔）

  // === 對話管理（stateless 必要）===
  conversationStore: ConversationStore    // 對話持久化（見準則 5）
  conversationId: string                  // 對話 ID
  initialMessages?: Message[]             // 由 store.loadActive() 提供

  // === 安全護欄 ===
  maxSteps?: number                       // 預設 25
  maxBudgetUsd?: number                   // 花費上限
  maxDurationMs?: number                  // 時間上限（serverless 建議設定）
  abortSignal?: AbortSignal               // 外部取消信號（HTTP req.signal / CLI SIGINT / ...）

  // === 進階 ===
  onToolCall?: ToolCallHook               // tool 呼叫攔截器
  onError?: ErrorHandler                  // 錯誤處理策略
  compactionStrategy?: CompactionStrategy // context window 管理
}
```

### 準則 4：Context 用 Provider Pattern 注入

取代 Claude Code 的 `getUserContext()` / `getSystemContext()` / CLAUDE.md。

```typescript
// Context Provider 介面
interface ContextProvider {
  name: string
  // 每個 turn 開始時呼叫，回傳要注入的 context
  resolve(ctx: ContextResolveParams): Promise<ContextBlock | null>
}

interface ContextBlock {
  content: string
  // 控制注入位置
  placement: 'system' | 'user-prefix'
}

interface ContextResolveParams {
  conversationId: string
  turnIndex: number
  userId?: string
  metadata?: Record<string, unknown>
}
```

**使用方式：**

```typescript
// 注入用戶資料
const userProfileProvider: ContextProvider = {
  name: 'user-profile',
  async resolve({ userId }) {
    const user = await db.users.findById(userId)
    return {
      content: `Current user: ${user.name}, role: ${user.role}, plan: ${user.plan}`,
      placement: 'system',
    }
  },
}

// 注入業務 context
const businessContextProvider: ContextProvider = {
  name: 'business-rules',
  async resolve() {
    return {
      content: `## Business Rules\n- 退款上限 30 天\n- VIP 用戶可跳過審核`,
      placement: 'system',
    }
  },
}

// 注入即時資料
const realtimeDataProvider: ContextProvider = {
  name: 'realtime-metrics',
  async resolve() {
    const metrics = await getRealtimeMetrics()
    return {
      content: `Current system status: ${JSON.stringify(metrics)}`,
      placement: 'user-prefix',
    }
  },
}

// 注意：每次 engine.run() 都會重新 resolve 所有 providers。
// 如果某個 provider 的資料取得很昂貴（例如查 DB），
// 由使用者自己在 provider 實作中做 application-level caching（Redis 等）。
// 在 CLI 等長駐場景中，也可以在 provider 內部用簡單的記憶體快取。
```

### 準則 5：Append-Only 對話儲存

採用 Append-only 策略（與 Claude Code 相同）。原因：用戶需要查看完整對話紀錄。

**核心概念：記憶體裡只保留 active messages（boundary 之後），Store 裡保留全部。**

```
                    記憶體 (engine.messages)
                    ┌──────────────────────────┐
                    │ boundary, summary,       │  ← 只有 active 部分
                    │ msg48, msg49, msg50      │    送給 LLM 用
                    └──────────────────────────┘

                    Store (DB / Redis)
                    ┌──────────────────────────┐
                    │ msg1, msg2, ... msg50,   │  ← 完整歷史
                    │ BOUNDARY, summary,       │    用戶可查看
                    │ msg48, msg49, msg50,     │    前端可渲染
                    │ msg51, msg52, ...        │
                    └──────────────────────────┘
```

```typescript
interface ConversationStore {
  // 追加訊息（永不覆蓋已存在的訊息）
  append(conversationId: string, messages: Message[]): Promise<void>

  // 載入完整歷史（用戶查看對話紀錄用）
  loadAll(conversationId: string): Promise<Message[] | null>

  // 載入 active 訊息（最後一個 compact boundary 之後）
  // Engine 初始化時用這個，不需要完整歷史
  loadActive(conversationId: string): Promise<Message[] | null>

  // 列出用戶的對話
  list?(userId: string, options?: { limit?: number; cursor?: string }): Promise<ConversationListResult>
}

interface ConversationListResult {
  conversations: ConversationSummary[]
  nextCursor?: string
}

interface ConversationSummary {
  id: string
  title?: string
  lastMessageAt: Date
  messageCount: number
  compactionCount: number  // 壓縮過幾次（代表對話長度）
}
```

**Compact Boundary Message 格式：**

```typescript
// 特殊的系統訊息，標記 compaction 發生的位置
interface CompactBoundaryMessage {
  role: 'system'
  type: 'compact_boundary'
  metadata: {
    trigger: 'auto' | 'manual'
    compactedMessageCount: number    // 被壓縮了幾條訊息
    preCompactTokenCount: number     // 壓縮前的 token 數
    postCompactTokenCount: number    // 壓縮後的 token 數
    timestamp: Date
  }
}
```

**Store 與 Compaction 的協作流程：**

```
Compact 觸發
  │
  ├─ 1. LLM 生成摘要 summary
  │
  ├─ 2. 建構 post-compact messages:
  │     [BOUNDARY, summary_user_msg, summary_assistant_ack, ...keptMessages]
  │
  ├─ 3. Store.append(conversationId, postCompactMessages)
  │     → 追加到 DB，不刪除舊訊息
  │
  ├─ 4. 記憶體替換：engine.messages = postCompactMessages
  │     → 只保留 active 部分，節省記憶體
  │
  └─ 5. yield { type: 'compact', freedTokens, summary }
```

**Resume（恢復對話）流程：**

```typescript
// Engine 初始化時
const engine = new AgentEngine({
  conversationStore: store,
  // loadActive 會自動找最後一個 boundary，只載入之後的訊息
  initialMessages: await store.loadActive(conversationId),
})

// 前端顯示完整歷史時
const allMessages = await store.loadAll(conversationId)
// allMessages 包含所有訊息 + boundary markers
// 前端可以用 boundary marker 做視覺分隔（"--- 以上為早期對話摘要 ---"）
```

**內建實作：**

```typescript
// ⚠️ 記憶體 store — Map 不跨 process 保留。
// 適用於：開發/測試、CLI 單次對話。
// 不適用於：serverless（每個 request 新 process）、多 instance 部署。
class MemoryConversationStore implements ConversationStore {
  private store = new Map<string, Message[]>()

  async append(id, messages) {
    const existing = this.store.get(id) ?? []
    this.store.set(id, [...existing, ...messages])
  }

  async loadAll(id) {
    return this.store.get(id) ?? null
  }

  async loadActive(id) {
    const all = await this.loadAll(id)
    if (!all) return null
    return getMessagesAfterCompactBoundary(all)
  }
}

// 使用者自訂 — Postgres 範例
class PostgresConversationStore implements ConversationStore {
  async append(id, messages) {
    await db.messages.insertMany(
      messages.map((msg, i) => ({
        conversationId: id,
        sequence: await this.getNextSequence(id),
        data: JSON.stringify(msg),
        type: msg.type ?? msg.role,
        createdAt: new Date(),
      }))
    )
  }

  async loadAll(id) {
    const rows = await db.messages.findMany({
      where: { conversationId: id },
      orderBy: { sequence: 'asc' },
    })
    return rows.map(r => JSON.parse(r.data))
  }

  async loadActive(id) {
    // 優化：用 SQL 找最後一個 boundary，只載入之後的
    const lastBoundary = await db.messages.findFirst({
      where: { conversationId: id, type: 'compact_boundary' },
      orderBy: { sequence: 'desc' },
    })
    const rows = await db.messages.findMany({
      where: {
        conversationId: id,
        sequence: { gte: lastBoundary?.sequence ?? 0 },
      },
      orderBy: { sequence: 'asc' },
    })
    return rows.map(r => JSON.parse(r.data))
  }
}
```

**前端渲染完整歷史：**

```tsx
// 前端可以區分 compact boundary 做視覺分隔
function ConversationHistory({ messages }: { messages: Message[] }) {
  return messages.map((msg, i) => {
    if (msg.type === 'compact_boundary') {
      return (
        <div key={i} className="compact-divider">
          <span>Earlier conversation summarized ({msg.metadata.compactedMessageCount} messages)</span>
        </div>
      )
    }
    return <MessageBubble key={i} message={msg} />
  })
}
```

### 準則 6：System Prompt 分層組裝

從 Claude Code 的 `getSystemPrompt()` 學到：prompt 是組裝的，不是一整段寫死的。

```typescript
// PromptBuilder 內部流程
class PromptBuilder {
  build(config: AgentEngineConfig, turnContext: TurnContext): string {
    const sections: string[] = []

    // Layer 1: 角色定義（固定）
    sections.push(config.systemPrompt ?? this.defaultRolePrompt())

    // Layer 2: Tool 使用指引（根據註冊的 tools 自動生成）
    sections.push(this.buildToolGuidance(config.tools))

    // Layer 3: Context providers 的結果（動態）
    for (const block of turnContext.resolvedContexts) {
      if (block.placement === 'system') {
        sections.push(block.content)
      }
    }

    // Layer 4: 額外指令（可插拔）
    if (config.instructions) {
      sections.push(config.instructions.join('\n\n'))
    }

    // Layer 5: 護欄指令（自動注入）
    sections.push(this.buildGuardrails(config))

    return sections.filter(Boolean).join('\n\n')
  }

  // 從 Claude Code 學到：教 LLM 怎麼用你的 tools 比只靠 tool description 更有效
  private buildToolGuidance(tools: Record<string, Tool>): string {
    const toolNames = Object.keys(tools)
    const lines = [
      '# Available Tools',
      `You have ${toolNames.length} tools available. Use them to answer the user's questions.`,
      'Call multiple tools in parallel when they are independent of each other.',
      'If a tool call fails, analyze the error before retrying.',
    ]
    return lines.join('\n')
  }
}
```

---

## 3. Context Window 管理（Compaction）

這是你**必須自建**的部分，AI SDK 不提供。從 Claude Code 的三層 compaction 簡化為：

```typescript
interface CompactionStrategy {
  // 判斷是否需要壓縮
  shouldCompact(messages: Message[], usage: TokenUsage): boolean
  // 執行壓縮
  compact(messages: Message[], model: string): Promise<CompactionResult>
}

interface CompactionResult {
  activeMessages: Message[]  // 壓縮後的 active 訊息（送 LLM 用）
  appendMessages: Message[]  // 要 append 到 store 的訊息（含 boundary）
  summary: string            // 被壓縮內容的摘要
  freedTokens: number        // 釋放了多少 token
  compactedCount: number     // 被壓縮的訊息數
}

// 預設實作：token threshold compaction
class ThresholdCompactionStrategy implements CompactionStrategy {
  constructor(private threshold: number = 0.75) {} // context window 75% 時觸發

  shouldCompact(messages: Message[], usage: TokenUsage): boolean {
    const contextWindow = getModelContextWindow(usage.model)
    return usage.totalTokens > contextWindow * this.threshold
  }

  async compact(messages: Message[], model: string): Promise<CompactionResult> {
    // 1. 保留最近 N 條訊息不壓縮
    const keepRecent = 6  // 最近 3 個 turn
    const toCompact = messages.slice(0, -keepRecent)
    const toKeep = messages.slice(-keepRecent)

    // 2. 用 LLM 摘要被壓縮的部分
    const { text } = await generateText({
      model,
      prompt: `Summarize this conversation concisely, preserving key facts, decisions, and context needed for continuation:\n\n${formatMessages(toCompact)}`,
    })

    // 3. 建構結果
    const boundary: CompactBoundaryMessage = {
      role: 'system',
      type: 'compact_boundary',
      metadata: {
        trigger: 'auto',
        compactedMessageCount: toCompact.length,
        preCompactTokenCount: estimateTokens(messages),
        postCompactTokenCount: estimateTokens(text) + estimateTokens(toKeep),
        timestamp: new Date(),
      },
    }
    const summaryUser = { role: 'user', content: `[Previous conversation summary]\n${text}` }
    const summaryAck = { role: 'assistant', content: 'Understood. I have the context from our previous conversation.' }

    const activeMessages = [boundary, summaryUser, summaryAck, ...toKeep]

    return {
      activeMessages,                                     // 記憶體用（送 LLM）
      appendMessages: [boundary, summaryUser, summaryAck], // Store 追加（toKeep 已在 store 裡）
      summary: text,
      freedTokens: estimateTokens(toCompact) - estimateTokens(text),
      compactedCount: toCompact.length,
    }
  }
}
```

### Compaction 在 agentic loop 中的位置

```
engine.run(input)
  │
  ├─ 1. resolveContextProviders()
  ├─ 2. buildSystemPrompt()
  ├─ 3. appendUserMessage(input)
  │
  ├─ 4. *** compaction check ***
  │     if (compactionStrategy.shouldCompact(messages, usage)):
  │       result = await compact(messages)   ← 額外一次 LLM call（注意 timeout）
  │       store.append(conversationId, result.appendMessages)  ← 追加到 store
  │       engine.messages = result.activeMessages              ← 記憶體替換
  │       yield { type: 'compact', freedTokens, summary }
  │     ⚠️ compact 是額外一次 LLM API call（生成摘要），加上主 query
  │        有 timeout 限制的環境（serverless 等）需考慮這個。
  │
  ├─ 5. streamText({ model, system, messages, tools })
  │     for each part:
  │       yield agentEvent
  │
  ├─ 6. if stop_reason is tool_use:
  │       execute tools
  │       append tool results
  │       goto 4  ← 每個 step 都檢查 compaction
  │
  └─ 7. yield result event
```

---

## 4. 完整 AgentEngine 實作細節

### 4.1 核心類別

```typescript
import { streamText, generateText, stepCountIs, tool, type UIMessage } from 'ai'
import { z } from 'zod'

export class AgentEngine {
  private config: AgentEngineConfig
  private messages: UIMessage[]           // 從 store 載入的 active messages
  private totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

  constructor(config: AgentEngineConfig) {
    this.config = config
    // Stateless: 每次建構都從外部提供（store.loadActive 的結果）
    this.messages = config.initialMessages ? [...config.initialMessages] : []
  }

  async *run(
    input: string | ContentPart[],
    options?: { metadata?: Record<string, unknown> }
  ): AsyncGenerator<AgentEvent> {
    const abortSignal = this.config.abortSignal  // 外部取消信號
    const startTime = Date.now()
    const store = this.config.conversationStore
    const conversationId = this.config.conversationId
    const turnContext = await this.prepareTurn(options?.metadata)

    // Append user message → 立刻 persist（中斷也不會遺失）
    const userMessage = { role: 'user', content: input }
    this.messages.push(userMessage)
    await store.append(conversationId, [userMessage])

    // Compaction check before API call
    yield* this.compactIfNeeded()

    // Build system prompt
    const system = this.config.promptBuilder
      ? this.config.promptBuilder.build(this.config, turnContext)
      : this.defaultBuildPrompt(turnContext)

    // Run the AI SDK loop
    let stepCount = 0
    const maxSteps = this.config.maxSteps ?? 25

    try {
      const result = streamText({
        model: this.config.model,
        system,
        messages: this.messages,
        tools: this.config.tools,
        stopWhen: stepCountIs(maxSteps),
        abortSignal: abortSignal,
      })

      for await (const part of result.fullStream) {
        // Budget check
        if (this.config.maxBudgetUsd && this.isOverBudget()) {
          yield { type: 'error', error: new Error('Budget exceeded'), recoverable: false }
          return
        }

        // Duration check
        if (this.config.maxDurationMs && (Date.now() - startTime) > this.config.maxDurationMs) {
          yield { type: 'error', error: new Error('Duration exceeded'), recoverable: false }
          return
        }

        // Map AI SDK events to AgentEvents
        // mapStreamPart 內部：每收到完整的 assistant message 或 tool_result
        // 就立刻 store.append()，不等 turn 結束
        yield* this.mapStreamPart(part)
      }

      // Accumulate usage
      const finalResult = await result
      this.accumulateUsage(finalResult.usage)
      // 注意：assistant / tool_result 訊息在 mapStreamPart() 中已即時 persist
      // 不做批次寫入 — process 可能隨時被 kill（serverless timeout / SIGTERM），批次會遺失資料

      // Yield final result
      yield {
        type: 'result',
        text: finalResult.text,
        usage: this.totalUsage,
        durationMs: Date.now() - startTime,
      }

    } catch (error) {
      yield* this.handleError(error as Error)
    }
  }

  getMessages(): readonly UIMessage[] {
    return this.messages
  }

  getUsage(): TokenUsage {
    return { ...this.totalUsage }
  }
}
```

### 4.2 Tool 定義模式

你的業務 API 作為 tools：

```typescript
import { tool } from 'ai'
import { z } from 'zod'

// 你的 API 包裝成 tool
export function createBusinessTools(apiClient: YourAPIClient) {
  return {
    // 查詢營收
    query_revenue: tool({
      description: '查詢指定時間範圍的營收資料',
      inputSchema: z.object({
        startDate: z.string().describe('開始日期 YYYY-MM-DD'),
        endDate: z.string().describe('結束日期 YYYY-MM-DD'),
        groupBy: z.enum(['day', 'week', 'month']).optional(),
      }),
      execute: async ({ startDate, endDate, groupBy }) => {
        return await apiClient.revenue.query({ startDate, endDate, groupBy })
      },
    }),

    // 查詢用戶
    get_user_info: tool({
      description: '取得用戶詳細資料',
      inputSchema: z.object({
        userId: z.string(),
      }),
      execute: async ({ userId }) => {
        return await apiClient.users.getById(userId)
      },
    }),

    // UI 渲染指令 tool（不執行 server 邏輯）
    render_chart: tool({
      description: '在對話中顯示圖表',
      inputSchema: z.object({
        title: z.string(),
        type: z.enum(['bar', 'line', 'pie', 'area']),
        data: z.array(z.object({
          label: z.string(),
          value: z.number(),
        })),
      }),
      execute: async (input) => ({ rendered: true }),
    }),

    suggest_actions: tool({
      description: '提供建議的下一步操作按鈕',
      inputSchema: z.object({
        buttons: z.array(z.object({
          label: z.string(),
          action: z.string(),
          variant: z.enum(['primary', 'secondary']).optional(),
        })),
      }),
      execute: async (input) => ({ rendered: true }),
    }),
  }
}
```

### 4.3 Error Recovery

```typescript
interface ErrorHandler {
  // 回傳 'retry' | 'fallback' | 'abort'
  handle(error: Error, attempt: number): Promise<ErrorDecision>
}

type ErrorDecision =
  | { action: 'retry'; delayMs: number }
  | { action: 'fallback'; model: string }  // 換模型重試
  | { action: 'abort'; message: string }

// 預設實作
class DefaultErrorHandler implements ErrorHandler {
  constructor(private fallbackModel?: string) {}

  async handle(error: Error, attempt: number): Promise<ErrorDecision> {
    // Rate limit → 退避重試
    if (isRateLimitError(error)) {
      return { action: 'retry', delayMs: Math.min(1000 * 2 ** attempt, 30000) }
    }

    // Overloaded → 最多重試 3 次
    if (isOverloadedError(error) && attempt < 3) {
      return { action: 'retry', delayMs: 5000 }
    }

    // 其他錯誤且有 fallback model → 換模型
    if (this.fallbackModel && attempt < 2) {
      return { action: 'fallback', model: this.fallbackModel }
    }

    return { action: 'abort', message: error.message }
  }
}
```

---

## 5. SDK 對外 API 設計

### 5.1 最簡使用（3 分鐘上手）

```typescript
import { AgentEngine, MemoryConversationStore } from '@yourcompany/agent-sdk'

// ─── 最簡：CLI one-liner ───
const store = new MemoryConversationStore()
const engine = new AgentEngine({
  model: 'anthropic/claude-sonnet-4.5',
  tools: createBusinessTools(apiClient),
  conversationStore: store,
  conversationId: 'demo',
  initialMessages: [],
})
for await (const event of engine.run('What is the weather?')) {
  if (event.type === 'text-delta') process.stdout.write(event.text)
}

// ─── HTTP API Route ───
export async function POST(req: Request) {
  const { message, conversationId } = await req.json()
  const store = new PostgresConversationStore(db)

  const engine = new AgentEngine({
    model: 'anthropic/claude-sonnet-4.5',
    tools: createBusinessTools(apiClient),
    conversationStore: store,
    conversationId,
    initialMessages: await store.loadActive(conversationId) ?? [],
    abortSignal: req.signal,
  })

  return engine.toUIMessageStreamResponse(message)
}

// ─── 查看完整對話歷史（HTTP GET）───
export async function GET(req: Request) {
  const { conversationId } = req.params
  const store = new PostgresConversationStore(db)
  const messages = await store.loadAll(conversationId)
  return Response.json({ messages })
}
```

### 5.2 完整使用

```typescript
const engine = new AgentEngine({
  // LLM
  model: 'anthropic/claude-sonnet-4.5',

  // System prompt
  systemPrompt: `You are an AI assistant for Acme Corp's internal dashboard.
You help employees analyze business data and take actions.`,

  // 業務 API 作為 tools
  tools: {
    ...createBusinessTools(apiClient),
    ...createUITools(),         // render_chart, suggest_actions
    ...createActionTools(),     // send_email, create_ticket
  },

  // 動態 context 注入
  contextProviders: [
    userProfileProvider,        // 用戶資料
    businessRulesProvider,      // 業務規則
    realtimeMetricsProvider,    // 即時數據
  ],

  // 額外指令
  instructions: [
    'Always show revenue data as a chart when possible.',
    'Suggest next steps after every analysis.',
    'Use Traditional Chinese for all responses.',
  ],

  // 對話管理
  conversationStore: new PostgresConversationStore(db),
  conversationId,
  initialMessages: await store.loadActive(conversationId),

  // 護欄
  maxSteps: 30,
  maxBudgetUsd: 0.50,
  maxDurationMs: 120_000,       // 2 分鐘（serverless 建議設定；CLI 可不設）

  // Error recovery
  onError: new DefaultErrorHandler('openai/gpt-5.4'),  // fallback model

  // Context window 管理
  compactionStrategy: new ThresholdCompactionStrategy(0.75),

  // Tool call 攔截（application 層 permission）
  onToolCall: async ({ toolName, input }) => {
    if (toolName === 'send_email') {
      // 在這裡做 permission check
      const allowed = await checkPermission(currentUser, 'send_email')
      if (!allowed) return { action: 'deny', reason: 'Insufficient permissions' }
    }
    return { action: 'allow' }
  },
})
```

### 5.3 三種消費方式

```typescript
class AgentEngine {
  // 1. AsyncGenerator — 核心 API，所有 runtime 都能用
  async *run(input: string): AsyncGenerator<AgentEvent> {
    // CLI: for await + stdout
    // HTTP: 自行轉成 SSE
    // Queue: 收集 events 寫入 DB
  }

  // 2. HTTP streaming — 前端 useChat 直接接
  async toUIMessageStreamResponse(input: string): Promise<Response> {
    // 內部呼叫 run()，轉成 AI SDK 的 UIMessage stream format
    // 只在 HTTP 場景使用
  }

  // 3. 一次性呼叫 — cron / webhook / programmatic
  async generate(input: string): Promise<AgentResult> {
    let lastResult: AgentResult | null = null
    for await (const event of this.run(input)) {
      if (event.type === 'result') lastResult = event
    }
    return lastResult!
  }
}
```

---

## 6. 專案結構

```
packages/agent-sdk/
├── src/
│   ├── index.ts                     # Public API exports
│   ├── engine/
│   │   ├── AgentEngine.ts           # 核心 engine（~300 行）
│   │   ├── types.ts                 # AgentEvent, AgentEngineConfig, TokenUsage
│   │   └── errors.ts               # AgentError, BudgetExceededError
│   ├── prompt/
│   │   ├── PromptBuilder.ts         # System prompt 分層組裝
│   │   └── toolGuidance.ts          # 自動生成 tool 使用指引
│   ├── context/
│   │   ├── types.ts                 # ContextProvider, ContextBlock
│   │   ├── ContextManager.ts        # 並行 resolve 所有 providers
│   │   └── providers/               # 內建 providers（可選）
│   │       └── staticProvider.ts
│   ├── compaction/
│   │   ├── types.ts                 # CompactionStrategy
│   │   ├── ThresholdCompaction.ts   # 預設 compaction 實作
│   │   └── tokenEstimator.ts        # Token 數估算
│   ├── conversation/
│   │   ├── types.ts                 # ConversationStore, CompactBoundaryMessage
│   │   ├── MemoryStore.ts           # 記憶體 store（開發用）
│   │   ├── boundary.ts              # getMessagesAfterCompactBoundary()
│   │   └── serialization.ts         # Message 序列化/反序列化
│   ├── error/
│   │   ├── types.ts                 # ErrorHandler, ErrorDecision
│   │   └── DefaultErrorHandler.ts
│   └── budget/
│       ├── BudgetGuard.ts           # Token / USD / Duration 檢查
│       └── pricing.ts               # 模型價格表
├── package.json
├── tsconfig.json
└── README.md
```

---

## 7. Implementation Roadmap

### Phase 1：Core Loop（1 週）

**目標：** 最小可用的 agentic loop

實作：
- [ ] `AgentEngine` 基本結構 + `run()` AsyncGenerator
- [ ] `PromptBuilder` 基本分層組裝
- [ ] 用 AI SDK `streamText` + `stopWhen: stepCountIs()` 實作 agentic loop
- [ ] `AgentEvent` type 定義 + stream mapping
- [ ] `toUIMessageStreamResponse()` 整合

驗證：
```typescript
const store = new MemoryConversationStore()
const engine = new AgentEngine({
  model: 'anthropic/claude-sonnet-4.5',
  systemPrompt: 'You are helpful.',
  tools: { get_weather: weatherTool },
  conversationStore: store,
  conversationId: 'test-1',
  initialMessages: [],
})
for await (const event of engine.run('What is the weather?')) {
  console.log(event)
}
// 驗證 store 裡有 user + assistant messages
const saved = await store.loadAll('test-1')
assert(saved.length >= 2)
```

### Phase 2：Context & Conversation（1 週）

**目標：** 多 turn 對話 + 動態 context + Append-only 持久化

實作：
- [ ] `ContextProvider` 介面 + `ContextManager`（並行 resolve，無快取）
- [ ] `ConversationStore` 介面（append / loadAll / loadActive）
- [ ] `MemoryConversationStore` 內建實作
- [ ] `CompactBoundaryMessage` 格式 + `getMessagesAfterCompactBoundary()`
- [ ] 即時持久化：每個 user/assistant message 立即 append 到 store
- [ ] 對話 resume：`store.loadActive()` → `initialMessages`
- [ ] 對話歷史 API：`store.loadAll()` 回傳含 boundary 的完整歷史

驗證：
```typescript
const store = new MemoryConversationStore()
const convId = 'test-123'

// Turn 1（新對話）
const engine1 = new AgentEngine({
  model: 'anthropic/claude-sonnet-4.5',
  tools, conversationStore: store, conversationId: convId,
  initialMessages: await store.loadActive(convId),  // null → 空
})
for await (const e of engine1.run('查詢上月營收')) { ... }
// engine1 被 GC

// Turn 2（新 request，從 store 恢復）
const engine2 = new AgentEngine({
  model: 'anthropic/claude-sonnet-4.5',
  tools, conversationStore: store, conversationId: convId,
  initialMessages: await store.loadActive(convId),  // 自動帶 turn 1 context
})
for await (const e of engine2.run('跟去年同期比較')) { ... }

// 查看完整歷史（含壓縮前的訊息）
const fullHistory = await store.loadAll(convId)
// Resume 驗證：loadActive 應只回傳 boundary 之後的
const active = await store.loadActive(convId)
assert(active.length < fullHistory.length)  // 如果發生過 compaction
```

### Phase 3：Safety & Compaction（1 週）

**目標：** Production-ready 的安全護欄

實作：
- [ ] `BudgetGuard`（maxSteps, maxBudgetUsd, maxDurationMs）
- [ ] `CompactionStrategy` 介面 + `ThresholdCompaction`
- [ ] Token 估算器
- [ ] `ErrorHandler` + retry / model fallback
- [ ] `onToolCall` 攔截器（permission hook）
- [ ] `abortSignal` 支援（HTTP req.signal / CLI SIGINT handler / 外部取消）

驗證：
- 跑 50 步的對話，確認 compaction 觸發
- 設 $0.01 budget，確認超過時停止
- 模擬 rate limit，確認 retry 策略

### Phase 4：Polish & Publish（3-5 天）

- [ ] TypeScript 型別完善（generic constraints, inference）
- [ ] 輸出 ESM + CJS
- [ ] 完善 JSDoc
- [ ] 補足 edge cases（empty response, malformed tool output）
- [ ] npm publish

---

## 8. 關鍵設計決定摘要

| # | 決定 | 理由 |
|---|------|------|
| 1 | 用 AI SDK 而非直接呼叫 provider SDK | 換 provider 只改一行 model 參數 |
| 2 | AsyncGenerator 而非 callback/EventEmitter | 天然背壓 + 順序保證 + 中斷友好 |
| 3 | 短命 engine — 每次 invocation 建構/銷毀 | 任何 runtime（HTTP / CLI / Cron）都適用，Store 是唯一 source of truth |
| 4 | Context 用 Provider pattern 注入 | 解耦業務知識和 agent 框架 |
| 5 | Prompt 分層組裝而非單一字串 | 可維護、可測試、各層獨立演進 |
| 6 | Compaction 在 agentic loop 內每步檢查 | 長對話不會爆 context window |
| 7 | Tool call hook 而非內建 permission | Permission 邏輯屬於 application 層 |
| 8 | ConversationStore Append-only | 用戶需查看完整歷史；記憶體只保留 active |
| 9 | Error handler 支援 model fallback | Production 必備的容錯 |
| 10 | 核心是 AsyncGenerator，HTTP streaming 是 adapter | run() 任何 runtime 能用；toUIMessageStreamResponse() 是 HTTP 專用捷徑 |

---

## 9. 不做什麼

明確排除，避免 scope creep：

- **不做本地檔案操作** — 這是雲端 agent
- **不做 prompt caching** — AI SDK / provider 自行處理
- **不做 UI 渲染** — SDK 只負責 event stream，前端自己畫
- **不做 permission UI** — `onToolCall` hook 給 application 層處理
- **不做 agent-to-agent 通訊** — 單一 agent scope
- **不做 plugin system** — tools + context providers 已經夠靈活
- **不做特定 runtime 的 adapter**（Express middleware / Next.js route handler 等）— SDK 只提供 `run()` + `toUIMessageStreamResponse()`，整合由使用者自己寫

---

## Appendix A：AI SDK API 速查（2026-04 最新）

```typescript
// Tool 定義：用 inputSchema 不是 parameters
tool({ description, inputSchema: z.object({...}), execute })

// Agentic loop：用 stopWhen 不是 maxSteps
streamText({ model, tools, stopWhen: stepCountIs(10) })

// Token 限制：用 maxOutputTokens 不是 maxTokens
streamText({ model, maxOutputTokens: 4096 })

// 前端 response：用 toUIMessageStreamResponse 不是 toDataStreamResponse
result.toUIMessageStreamResponse()

// 前端 useChat：自己管 input state
const { sendMessage } = useChat({ transport: new DefaultChatTransport({ api }) })

// Tool part：用 tool-{toolName} pattern（e.g. tool-weather, tool-getUser）
// part.input 不是 part.args
// part.output 不是 part.result
// part.state: 'input-streaming' | 'input-available' | 'output-available'
```
