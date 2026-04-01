import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { AgentEngine } from './AgentEngine.js'
import { MemoryConversationStore } from '../conversation/MemoryStore.js'
import type { AgentEngineConfig, AgentEvent } from './types.js'

vi.mock('ai', () => ({
  streamText: vi.fn(),
  stepCountIs: vi.fn((n: number) => ({ type: 'step-count', count: n })),
}))

vi.mock('../model/registry.js', () => ({
  getDefaultRegistry: vi.fn().mockReturnValue({
    resolve: vi.fn().mockResolvedValue({ modelId: 'mock' }),
  }),
}))

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createMockStream(
  parts: Array<Record<string, unknown>>,
  finalResult: { text: string; usage: { inputTokens: number; outputTokens: number } },
) {
  async function* generate() {
    for (const part of parts) {
      yield part
    }
  }

  return {
    fullStream: generate(),
    text: Promise.resolve(finalResult.text),
    totalUsage: Promise.resolve(finalResult.usage),
    usage: Promise.resolve(finalResult.usage),
    steps: Promise.resolve([]),
  }
}

function createDelayedMockStream(
  parts: Array<{ part: Record<string, unknown>; delayMs?: number }>,
  finalResult: { text: string; usage: { inputTokens: number; outputTokens: number } },
) {
  async function* generate() {
    for (const { part, delayMs } of parts) {
      if (delayMs) {
        await delay(delayMs)
      }
      yield part
    }
  }

  return {
    fullStream: generate(),
    text: Promise.resolve(finalResult.text),
    totalUsage: Promise.resolve(finalResult.usage),
    usage: Promise.resolve(finalResult.usage),
    steps: Promise.resolve([]),
  }
}

function makeConfig(overrides?: Partial<AgentEngineConfig>): AgentEngineConfig {
  return {
    model: 'anthropic/claude-sonnet-4.5',
    tools: {},
    conversationStore: new MemoryConversationStore(),
    conversationId: 'test-conv-safety',
    ...overrides,
  }
}

async function collectEvents(engine: AgentEngine, input: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of engine.run(input)) {
    events.push(event)
  }
  return events
}

describe('AgentEngine safety features', () => {
  let mockStreamText: Mock

  beforeEach(async () => {
    vi.clearAllMocks()
    const ai = await import('ai')
    mockStreamText = ai.streamText as unknown as Mock
  })

  it('stops when maxDurationMs is exceeded', async () => {
    mockStreamText.mockReturnValue(
      createDelayedMockStream(
        [
          { part: { type: 'text-delta', text: 'Hello' } },
          { part: { type: 'text-delta', text: ' world' }, delayMs: 100 },
        ],
        { text: 'Hello world', usage: { inputTokens: 10, outputTokens: 5 } },
      ),
    )

    const engine = new AgentEngine(makeConfig({ maxDurationMs: 1 }))
    const events = await collectEvents(engine, 'Hi')

    const errorEvent = events.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as any).error.message).toContain('Duration exceeded')
  })

  it('calls onToolCall hook before tool execution', async () => {
    const onToolCall = vi.fn().mockResolvedValue({ action: 'allow' })

    mockStreamText.mockReturnValue(
      createMockStream(
        [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'send_email',
            input: { to: 'x' },
          },
          {
            type: 'tool-result',
            toolName: 'send_email',
            toolCallId: 'tc-1',
            input: { to: 'x' },
            output: 'sent',
          },
        ],
        { text: '', usage: { inputTokens: 10, outputTokens: 5 } },
      ),
    )

    const engine = new AgentEngine(makeConfig({ onToolCall }))
    await collectEvents(engine, 'Send email')

    expect(onToolCall).toHaveBeenCalledWith({
      toolName: 'send_email',
      toolCallId: 'tc-1',
      input: { to: 'x' },
    })
  })

  it('denies tool call when onToolCall returns deny', async () => {
    const onToolCall = vi.fn().mockResolvedValue({ action: 'deny', reason: 'Nope' })

    mockStreamText.mockReturnValue(
      createMockStream(
        [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'send_email',
            input: { to: 'x' },
          },
        ],
        { text: '', usage: { inputTokens: 10, outputTokens: 5 } },
      ),
    )

    const engine = new AgentEngine(makeConfig({ onToolCall }))
    const events = await collectEvents(engine, 'Send email')

    // Should have a tool-call-complete with DENIED output
    const toolComplete = events.find((e) => e.type === 'tool-call-complete')
    expect(toolComplete).toBeDefined()
    expect((toolComplete as any).output).toContain('DENIED: Nope')

    // Should NOT have a tool-call-start event (denied before start)
    const toolStart = events.find((e) => e.type === 'tool-call-start')
    expect(toolStart).toBeUndefined()
  })
})
