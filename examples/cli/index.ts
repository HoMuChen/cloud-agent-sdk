import * as readline from 'node:readline'
import { AgentEngine, MemoryConversationStore } from 'cloud-agent-sdk'
import { tool } from 'ai'
import { z } from 'zod'

// ─── 定義 Tools ───

const tools = {
  get_weather: tool({
    description: '查詢指定城市的天氣',
    inputSchema: z.object({
      city: z.string().describe('城市名稱'),
    }),
    execute: async ({ city }) => {
      // 模擬 API 回應
      const conditions = ['晴天', '多雲', '小雨', '陰天']
      return {
        city,
        temperature: Math.round(Math.random() * 15 + 20),
        condition: conditions[Math.floor(Math.random() * conditions.length)],
      }
    },
  }),

  calculate: tool({
    description: '計算數學運算式',
    inputSchema: z.object({
      expression: z.string().describe('數學運算式，例如 "2 + 3 * 4"'),
    }),
    execute: async ({ expression }) => {
      // 安全的數學運算（僅允許數字和運算符）
      if (!/^[\d\s+\-*/().]+$/.test(expression)) {
        return { error: '不合法的運算式' }
      }
      try {
        const result = new Function(`return (${expression})`)()
        return { expression, result }
      } catch {
        return { error: '運算失敗' }
      }
    },
  }),

  get_time: tool({
    description: '取得目前時間',
    inputSchema: z.object({}),
    execute: async () => {
      return { time: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) }
    },
  }),
}

// ─── 建立 Store 和 Readline ───

const store = new MemoryConversationStore()
const conversationId = `cli-${Date.now()}`

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve))
}

// ─── 主程式 ───

async function main() {
  console.log('Cloud Agent SDK — CLI Example')
  console.log('輸入訊息開始對話，輸入 "exit" 離開\n')

  while (true) {
    const input = await prompt('You > ')
    if (input.trim().toLowerCase() === 'exit') break
    if (!input.trim()) continue

    process.stdout.write('AI  > ')

    const engine = new AgentEngine({
      model: 'anthropic/claude-sonnet-4-6',
      systemPrompt: '你是一個友善的 AI 助手，使用繁體中文回覆。',
      tools,
      conversationStore: store,
      conversationId,
      initialMessages: await store.loadActive(conversationId) ?? [],
      maxSteps: 10,
    })

    for await (const event of engine.run(input)) {
      switch (event.type) {
        case 'text-delta':
          process.stdout.write(event.text)
          break
        case 'tool-call-start':
          process.stdout.write(`\n  [呼叫 ${event.toolName}] `)
          break
        case 'tool-call-complete':
          process.stdout.write(`→ ${JSON.stringify(event.output)}\n`)
          break
        case 'result':
          console.log(`\n  (${event.usage.inputTokens}+${event.usage.outputTokens} tokens, ${event.durationMs}ms)`)
          break
        case 'error':
          console.error(`\n  [錯誤] ${event.error.message}`)
          break
      }
    }

    console.log()
  }

  rl.close()
  console.log('Bye!')
}

main()
