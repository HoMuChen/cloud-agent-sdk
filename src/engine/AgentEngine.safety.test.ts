import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { AgentEngine } from './AgentEngine.js'
import { MemoryConversationStore } from '../conversation/MemoryStore.js'
import type { AgentEngineConfig, AgentEvent, ErrorHandler, ErrorDecision, CompactionStrategy, CompactionResult, StoreMessage, TokenUsage } from './types.js'
import type { LanguageModel } from 'ai'

vi.mock('ai', () => ({
  streamText: vi.fn(),
  stepCountIs: vi.fn((n: number) => ({ type: 'step-count', count: n })),
}))

vi.mock('../model/registry.js', () => ({
  getDefaultRegistry: vi.fn().mockReturnValue({
    resolve: vi.fn().mockResolvedValue({ modelId: 'mock' }),
  }),
}))

vi.mock('../budget/pricing.js', () => ({
  getModelPricing: vi.fn().mockReturnValue({
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
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

  // === Issue C2: BudgetGuard tests ===

  it('stops when BudgetGuard detects budget exceeded via finish-step usage', async () => {
    // With default pricing: inputPerToken=0.000003, outputPerToken=0.000015
    // 1,000,000 input tokens * 0.000003 = $3.00, which exceeds $0.01 budget
    mockStreamText.mockReturnValue(
      createMockStream(
        [
          { type: 'text-delta', text: 'Hello' },
          { type: 'finish-step', usage: { inputTokens: 1000000, outputTokens: 0 } },
        ],
        { text: 'Hello', usage: { inputTokens: 1000000, outputTokens: 0 } },
      ),
    )

    const engine = new AgentEngine(makeConfig({ maxBudgetUsd: 0.01 }))
    const events = await collectEvents(engine, 'Hi')

    const errorEvent = events.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as any).error.message).toContain('Budget exceeded')
  })

  it('does not stop when usage is within budget', async () => {
    mockStreamText.mockReturnValue(
      createMockStream(
        [
          { type: 'text-delta', text: 'Hello' },
          { type: 'finish-step', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        { text: 'Hello', usage: { inputTokens: 10, outputTokens: 5 } },
      ),
    )

    const engine = new AgentEngine(makeConfig({ maxBudgetUsd: 10.0 }))
    const events = await collectEvents(engine, 'Hi')

    const errorEvent = events.find((e) => e.type === 'error')
    expect(errorEvent).toBeUndefined()

    const resultEvent = events.find((e) => e.type === 'result')
    expect(resultEvent).toBeDefined()
  })

  // === Issue C3: ErrorHandler tests ===

  it('retries on error when ErrorHandler returns retry', async () => {
    let callCount = 0
    mockStreamText.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        throw new Error('Rate limited')
      }
      // Second call succeeds
      return createMockStream(
        [{ type: 'text-delta', text: 'Recovered' }],
        { text: 'Recovered', usage: { inputTokens: 5, outputTokens: 2 } },
      )
    })

    const onError: ErrorHandler = {
      handle: vi.fn().mockResolvedValue({ action: 'retry', delayMs: 1 }),
    }

    const engine = new AgentEngine(makeConfig({ onError }))
    const events = await collectEvents(engine, 'Hi')

    expect(onError.handle).toHaveBeenCalledTimes(1)
    expect(callCount).toBe(2)

    const resultEvent = events.find((e) => e.type === 'result')
    expect(resultEvent).toBeDefined()
    expect((resultEvent as any).text).toBe('Recovered')
  })

  it('falls back to alternate model when ErrorHandler returns fallback', async () => {
    let callCount = 0
    mockStreamText.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        throw new Error('Overloaded')
      }
      return createMockStream(
        [{ type: 'text-delta', text: 'Fallback response' }],
        { text: 'Fallback response', usage: { inputTokens: 5, outputTokens: 3 } },
      )
    })

    const onError: ErrorHandler = {
      handle: vi.fn().mockResolvedValue({ action: 'fallback', model: 'openai/gpt-4o' }),
    }

    const engine = new AgentEngine(makeConfig({ onError }))
    const events = await collectEvents(engine, 'Hi')

    expect(onError.handle).toHaveBeenCalledTimes(1)
    expect(callCount).toBe(2)

    const resultEvent = events.find((e) => e.type === 'result')
    expect(resultEvent).toBeDefined()
    expect((resultEvent as any).text).toBe('Fallback response')
  })

  it('yields error when ErrorHandler returns abort', async () => {
    mockStreamText.mockImplementation(() => {
      throw new Error('Fatal error')
    })

    const onError: ErrorHandler = {
      handle: vi.fn().mockResolvedValue({ action: 'abort', message: 'Giving up' }),
    }

    const engine = new AgentEngine(makeConfig({ onError }))
    const events = await collectEvents(engine, 'Hi')

    expect(onError.handle).toHaveBeenCalledTimes(1)

    const errorEvent = events.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as any).error.message).toBe('Fatal error')
    expect((errorEvent as any).recoverable).toBe(false)
  })

  it('yields error without consulting ErrorHandler if not configured', async () => {
    mockStreamText.mockImplementation(() => {
      throw new Error('Stream failed')
    })

    const engine = new AgentEngine(makeConfig())
    const events = await collectEvents(engine, 'Hi')

    const errorEvent = events.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as any).error.message).toBe('Stream failed')
  })

  // === Issue C4: CompactionStrategy tests ===

  it('invokes compactionStrategy after stream completes when shouldCompact returns true', async () => {
    mockStreamText.mockReturnValue(
      createMockStream(
        [{ type: 'text-delta', text: 'Reply' }],
        { text: 'Reply', usage: { inputTokens: 500, outputTokens: 200 } },
      ),
    )

    const mockCompactionResult: CompactionResult = {
      activeMessages: [
        { role: 'system', content: '[Compact Boundary]' },
        { role: 'user', content: '[Previous conversation summary]\nSummary text' },
        { role: 'assistant', content: 'Understood.' },
      ],
      appendMessages: [
        { role: 'system', content: '[Compact Boundary]' },
        { role: 'user', content: '[Previous conversation summary]\nSummary text' },
        { role: 'assistant', content: 'Understood.' },
      ],
      summary: 'Summary text',
      freedTokens: 100,
      compactedCount: 5,
    }

    const compactionStrategy: CompactionStrategy = {
      shouldCompact: vi.fn().mockReturnValue(true),
      compact: vi.fn().mockResolvedValue(mockCompactionResult),
    }

    const store = new MemoryConversationStore()
    const engine = new AgentEngine(makeConfig({ compactionStrategy, conversationStore: store }))
    const events = await collectEvents(engine, 'Hello')

    // Should have a compact event
    const compactEvent = events.find((e) => e.type === 'compact')
    expect(compactEvent).toBeDefined()
    expect((compactEvent as any).freedTokens).toBe(100)
    expect((compactEvent as any).summary).toBe('Summary text')
    expect((compactEvent as any).compactedCount).toBe(5)

    // shouldCompact should have been called
    expect(compactionStrategy.shouldCompact).toHaveBeenCalled()
    // compact should have been called
    expect(compactionStrategy.compact).toHaveBeenCalled()

    // Messages should be replaced with compacted set
    const msgs = engine.getMessages()
    expect(msgs).toEqual(mockCompactionResult.activeMessages)
  })

  it('does not compact when shouldCompact returns false', async () => {
    mockStreamText.mockReturnValue(
      createMockStream(
        [{ type: 'text-delta', text: 'Reply' }],
        { text: 'Reply', usage: { inputTokens: 10, outputTokens: 5 } },
      ),
    )

    const compactionStrategy: CompactionStrategy = {
      shouldCompact: vi.fn().mockReturnValue(false),
      compact: vi.fn(),
    }

    const engine = new AgentEngine(makeConfig({ compactionStrategy }))
    const events = await collectEvents(engine, 'Hello')

    const compactEvent = events.find((e) => e.type === 'compact')
    expect(compactEvent).toBeUndefined()
    expect(compactionStrategy.compact).not.toHaveBeenCalled()
  })
})
