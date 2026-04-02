# cloud-agent-sdk

為既有 API 加上 AI 對話能力的 TypeScript SDK。基於 [Vercel AI SDK](https://sdk.vercel.ai)，提供 agentic loop、對話持久化、context 注入、自動壓縮、預算控制。

## 安裝

```bash
npm install cloud-agent-sdk
```

安裝你需要的 LLM provider（至少一個）：

```bash
npm install @ai-sdk/anthropic   # Anthropic (Claude)
npm install @ai-sdk/openai      # OpenAI
npm install @ai-sdk/google       # Google (Gemini)
```

## 快速開始

### 最簡範例（CLI）

```typescript
import { AgentEngine, MemoryConversationStore } from 'cloud-agent-sdk'
import { tool } from 'ai'
import { z } from 'zod'

const store = new MemoryConversationStore()

const engine = new AgentEngine({
  model: 'anthropic/claude-sonnet-4-6',
  tools: {
    get_weather: tool({
      description: '查詢天氣',
      inputSchema: z.object({
        city: z.string().describe('城市名稱'),
      }),
      execute: async ({ city }) => ({ city, temp: 25, condition: 'sunny' }),
    }),
  },
  conversationStore: store,
  conversationId: 'demo',
})

for await (const event of engine.run('台北今天天氣如何？')) {
  if (event.type === 'text-delta') process.stdout.write(event.text)
  if (event.type === 'tool-call-start') console.log(`\n[呼叫 ${event.toolName}]`)
  if (event.type === 'result') console.log(`\n\n(tokens: ${event.usage.inputTokens}+${event.usage.outputTokens})`)
}
```

### HTTP API Route（搭配前端 useChat）

```typescript
import { AgentEngine } from 'cloud-agent-sdk'

// 共用的 engine factory
async function createEngine(conversationId: string, opts?: { abortSignal?: AbortSignal }) {
  const store = new PostgresConversationStore(db) // 你自己實作的 store
  return new AgentEngine({
    model: 'anthropic/claude-sonnet-4-6',
    tools: createBusinessTools(apiClient),
    conversationStore: store,
    conversationId,
    initialMessages: await store.loadActive(conversationId) ?? [],
    abortSignal: opts?.abortSignal,
  })
}

// POST — AI 對話（串流）
export async function POST(req: Request) {
  const { message, conversationId } = await req.json()
  const engine = await createEngine(conversationId, { abortSignal: req.signal })
  return engine.toUIMessageStreamResponse(message)
}

// GET — 查看完整對話歷史
export async function GET(req: Request) {
  const conversationId = new URL(req.url).searchParams.get('id')!
  const store = new PostgresConversationStore(db)
  const messages = await store.loadAll(conversationId)
  return Response.json({ messages })
}
```

前端用 AI SDK 的 `useChat` 直接接收：

```tsx
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'

const { messages, sendMessage } = useChat({
  transport: new DefaultChatTransport({ api: '/api/chat' }),
})
```

### 非串流呼叫（Cron / Queue）

```typescript
const engine = await createEngine(job.conversationId)
const result = await engine.generate(job.message)
console.log(result.text)
```

## 核心概念

### AgentEngine

短命實例 — 每次呼叫建構、執行、銷毀。不保留跨呼叫的狀態。

三種消費方式：

| 方法 | 用途 | 回傳 |
|------|------|------|
| `run(input)` | 核心 API，任何 runtime 都能用 | `AsyncGenerator<AgentEvent>` |
| `toUIMessageStreamResponse(input)` | HTTP 串流，前端 useChat 直接接 | `Promise<Response>` |
| `generate(input)` | 非串流，cron / webhook / programmatic | `Promise<ResultEvent>` |

### AgentEvent

所有事件通過 discriminated union 統一：

```typescript
type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-start'; toolName: string; toolCallId: string }
  | { type: 'tool-call-complete'; toolName: string; toolCallId: string; input: unknown; output: unknown }
  | { type: 'compact'; freedTokens: number; summary: string; compactedCount: number }
  | { type: 'status'; message: string }
  | { type: 'error'; error: Error; recoverable: boolean }
  | { type: 'result'; text: string; usage: TokenUsage; durationMs: number }
```

### Model 設定

三種方式指定 model：

**1. 字串格式（API key 從環境變數讀取）：**

```typescript
new AgentEngine({
  model: 'anthropic/claude-sonnet-4-6',
  ...
})
// 自動讀取 ANTHROPIC_API_KEY 環境變數
```

支援的格式：`'anthropic/claude-sonnet-4-6'`、`'openai/gpt-4o'`、`'google/gemini-2.0-flash'`

**2. 字串格式 + 傳入 apiKey：**

```typescript
new AgentEngine({
  model: 'anthropic/claude-sonnet-4-6',
  apiKey: 'sk-ant-xxxxx',
  ...
})
```

**3. 直接傳 LanguageModel instance（完全控制）：**

```typescript
import { createAnthropic } from '@ai-sdk/anthropic'

const anthropic = createAnthropic({ apiKey: 'sk-ant-xxxxx', baseURL: '...' })
new AgentEngine({
  model: anthropic('claude-sonnet-4-6'),
  ...
})
```

**註冊自定義 provider：**

```typescript
import { getDefaultRegistry } from 'cloud-agent-sdk'

getDefaultRegistry().registerProvider('custom', (modelId) => {
  return myCustomProvider(modelId)
})
// 之後就能用 'custom/my-model'
```

## Tool 註冊

Tools 使用 Vercel AI SDK 的 `tool()` 函式定義，以 `Record<string, Tool>` 傳入 AgentEngine。

### tool() 介面

```typescript
import { tool } from 'ai'
import { z } from 'zod'

tool({
  description: string,         // 告訴 LLM 這個 tool 的用途
  inputSchema: ZodSchema,      // 用 Zod 定義輸入參數
  execute: (input) => Promise<any>,  // 實際執行邏輯
})
```

- **`description`** — LLM 根據它決定何時呼叫，寫清楚用途
- **`inputSchema`** — 用 Zod 定義，`.describe()` 幫助 LLM 理解參數意義
- **`execute`** — input 型別自動從 schema 推導，回傳值以 JSON 形式給 LLM

### 基本範例

```typescript
const tools = {
  get_order: tool({
    description: '查詢訂單詳細資料',
    inputSchema: z.object({
      orderId: z.string().describe('訂單編號'),
    }),
    execute: async ({ orderId }) => {
      return await db.orders.findById(orderId)
    },
  }),
}
```

### 包裝既有 API

將既有 API client 包成一組 tools，是這個 SDK 最主要的用法：

```typescript
export function createBusinessTools(apiClient: YourAPIClient) {
  return {
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

    get_user_info: tool({
      description: '取得用戶詳細資料',
      inputSchema: z.object({
        userId: z.string(),
      }),
      execute: async ({ userId }) => {
        return await apiClient.users.getById(userId)
      },
    }),

    create_ticket: tool({
      description: '建立客服工單',
      inputSchema: z.object({
        title: z.string(),
        priority: z.enum(['low', 'medium', 'high']),
        assignee: z.string().optional(),
      }),
      execute: async (input) => {
        return await apiClient.tickets.create(input)
      },
    }),
  }
}
```

### 傳入 AgentEngine

key 就是 tool 名稱（LLM 用來呼叫），建議用 `snake_case`：

```typescript
const engine = new AgentEngine({
  model: 'anthropic/claude-sonnet-4-6',
  tools: createBusinessTools(apiClient),
  // ...
})
```

合併多組 tools：

```typescript
tools: {
  ...createBusinessTools(apiClient),
  ...createAdminTools(adminClient),
  ...createUITools(),
},
```

## 對話管理

### ConversationStore

Append-only 介面，三個核心方法：

```typescript
interface ConversationStore {
  append(conversationId: string, messages: StoreMessage[]): Promise<void>
  loadAll(conversationId: string): Promise<StoreMessage[] | null>
  loadActive(conversationId: string): Promise<StoreMessage[] | null>
}
```

- `append` — 追加訊息，永不覆蓋
- `loadAll` — 完整歷史（前端渲染用）
- `loadActive` — 最後一個壓縮邊界之後的訊息（Engine 初始化用）

### 內建：MemoryConversationStore

記憶體 Map 儲存，適合開發 / 測試 / CLI 單次對話：

```typescript
import { MemoryConversationStore } from 'cloud-agent-sdk'
const store = new MemoryConversationStore()
```

### 自訂：Postgres 範例

```typescript
import type { ConversationStore, StoreMessage } from 'cloud-agent-sdk'
import { getMessagesAfterCompactBoundary } from 'cloud-agent-sdk'

class PostgresConversationStore implements ConversationStore {
  async append(id: string, messages: StoreMessage[]) {
    for (const msg of messages) {
      await db.messages.create({ conversationId: id, data: JSON.stringify(msg) })
    }
  }

  async loadAll(id: string) {
    const rows = await db.messages.findMany({ where: { conversationId: id }, orderBy: { id: 'asc' } })
    return rows.length ? rows.map(r => JSON.parse(r.data)) : null
  }

  async loadActive(id: string) {
    const all = await this.loadAll(id)
    if (!all) return null
    return getMessagesAfterCompactBoundary(all)
  }
}
```

### 多 Turn 對話

每個 turn 建一個新的 engine，從 store 載入之前的對話：

```typescript
// Turn 1
const engine1 = new AgentEngine({
  ...,
  conversationId: 'conv-1',
  initialMessages: await store.loadActive('conv-1') ?? [],
})
for await (const e of engine1.run('查詢上月營收')) { ... }

// Turn 2（新的 engine 實例，自動帶入 Turn 1 的 context）
const engine2 = new AgentEngine({
  ...,
  conversationId: 'conv-1',
  initialMessages: await store.loadActive('conv-1') ?? [],
})
for await (const e of engine2.run('跟去年同期比較')) { ... }
```

## Context Provider

動態注入 context 到 system prompt 或 user message 前綴：

```typescript
import type { ContextProvider } from 'cloud-agent-sdk'

const userProfileProvider: ContextProvider = {
  name: 'user-profile',
  async resolve({ userId }) {
    const user = await db.users.findById(userId)
    return {
      content: `使用者：${user.name}，角色：${user.role}`,
      placement: 'system',  // 注入到 system prompt
    }
  },
}

const engine = new AgentEngine({
  ...,
  contextProviders: [userProfileProvider],
})
```

也有簡便的 `staticProvider`：

```typescript
import { staticProvider } from 'cloud-agent-sdk'

const rules = staticProvider('rules', '退款上限 30 天', 'system')
```

`placement` 選項：
- `'system'` — 注入到 system prompt
- `'user-prefix'` — 注入到 user message 前面

## 安全護欄

### 預算控制

```typescript
const engine = new AgentEngine({
  ...,
  maxSteps: 30,           // 最多 30 步 tool call
  maxDurationMs: 120_000, // 時間上限 2 分鐘
})
```

超過任一限制會 yield `{ type: 'error', recoverable: false }` 並停止。

### Tool Call 攔截

在 tool 執行前做 permission check：

```typescript
const engine = new AgentEngine({
  ...,
  onToolCall: async ({ toolName, input }) => {
    if (toolName === 'send_email') {
      const allowed = await checkPermission(currentUser, 'send_email')
      if (!allowed) return { action: 'deny', reason: '權限不足' }
    }
    return { action: 'allow' }
  },
})
```

被拒絕的 tool call 會 yield `tool-call-complete` 事件，output 為 `"DENIED: 權限不足"`。

### 錯誤處理與 Model Fallback

```typescript
import { DefaultErrorHandler } from 'cloud-agent-sdk'

const engine = new AgentEngine({
  ...,
  onError: new DefaultErrorHandler('openai/gpt-4o'), // fallback model
})
```

`DefaultErrorHandler` 的策略：
- Rate limit (429) → exponential backoff 重試
- Overloaded (529/503) → 最多重試 3 次
- 其他錯誤 + 有 fallback model → 換模型重試
- 都失敗 → abort

也可以自訂：

```typescript
import type { ErrorHandler, ErrorDecision } from 'cloud-agent-sdk'

class MyErrorHandler implements ErrorHandler {
  async handle(error: Error, attempt: number): Promise<ErrorDecision> {
    // 自訂邏輯
    return { action: 'abort', message: error.message }
  }
}
```

## Context Window 壓縮

長對話自動壓縮，避免超出 context window：

```typescript
import { ThresholdCompactionStrategy } from 'cloud-agent-sdk'

const engine = new AgentEngine({
  ...,
  compactionStrategy: new ThresholdCompactionStrategy({
    threshold: 0.75,         // context window 75% 時觸發
    contextWindow: 200_000,  // model 的 context window 大小
    keepRecentMessages: 6,   // 保留最近 6 條不壓縮
  }),
})
```

壓縮時會：
1. 用 LLM 摘要舊訊息
2. 插入 compact boundary marker 到 store
3. 記憶體中只保留 boundary 之後的訊息
4. Yield `{ type: 'compact', freedTokens, summary, compactedCount }` 事件

## 完整設定範例

```typescript
const engine = new AgentEngine({
  // LLM
  model: 'anthropic/claude-sonnet-4-6',

  // System prompt
  systemPrompt: `你是 Acme Corp 的 AI 助手，幫助員工分析業務數據。`,

  // 業務 API 作為 tools
  tools: {
    query_revenue: tool({ ... }),
    get_user_info: tool({ ... }),
    render_chart: tool({ ... }),
  },

  // 動態 context
  contextProviders: [
    userProfileProvider,
    businessRulesProvider,
  ],

  // 額外指令
  instructions: [
    '營收資料盡量用圖表呈現。',
    '每次分析後建議下一步操作。',
    '使用繁體中文回覆。',
  ],

  // 對話管理
  conversationStore: new PostgresConversationStore(db),
  conversationId,
  initialMessages: await store.loadActive(conversationId) ?? [],

  // 護欄
  maxSteps: 30,
  maxDurationMs: 120_000,
  abortSignal: req.signal,

  // 錯誤處理
  onError: new DefaultErrorHandler('openai/gpt-4o'),

  // 壓縮
  compactionStrategy: new ThresholdCompactionStrategy({ threshold: 0.75 }),

  // Tool 攔截
  onToolCall: async ({ toolName }) => {
    if (restrictedTools.includes(toolName)) {
      return { action: 'deny', reason: '此操作需要管理員權限' }
    }
    return { action: 'allow' }
  },
})
```

## API 參考

### AgentEngineConfig

| 欄位 | 型別 | 必要 | 說明 |
|------|------|------|------|
| `model` | `string \| LanguageModel` | Yes | 字串格式 `'provider/model-id'` 或 AI SDK LanguageModel instance |
| `tools` | `Record<string, Tool>` | Yes | AI SDK tool 定義 |
| `conversationStore` | `ConversationStore` | Yes | 對話持久化 |
| `conversationId` | `string` | Yes | 對話 ID |
| `apiKey` | `string` | No | LLM provider 的 API key（字串 model 時使用，不設則讀環境變數）|
| `systemPrompt` | `string` | No | 角色定義 |
| `contextProviders` | `ContextProvider[]` | No | 動態 context 注入 |
| `instructions` | `string[]` | No | 額外指令 |
| `initialMessages` | `StoreMessage[]` | No | 從 store 載入的訊息 |
| `maxSteps` | `number` | No | Tool call 步數上限（預設 25）|
| `maxDurationMs` | `number` | No | 時間上限（毫秒）|
| `abortSignal` | `AbortSignal` | No | 外部取消信號 |
| `onToolCall` | `ToolCallHook` | No | Tool 呼叫攔截器 |
| `onError` | `ErrorHandler` | No | 錯誤處理策略 |
| `compactionStrategy` | `CompactionStrategy` | No | 壓縮策略 |

## License

MIT
