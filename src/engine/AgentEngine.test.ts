import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { AgentEngine } from './AgentEngine.js'
import { MemoryConversationStore } from '../conversation/MemoryStore.js'
import type { AgentEngineConfig } from './types.js'

vi.mock('ai', () => ({
  streamText: vi.fn(),
  stepCountIs: vi.fn((n: number) => ({ type: 'step-count', count: n })),
}))

vi.mock('../model/registry.js', () => ({
  getDefaultRegistry: vi.fn().mockReturnValue({
    resolve: vi.fn().mockResolvedValue({ modelId: 'mock-model' }),
  }),
}))

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

function makeConfig(overrides?: Partial<AgentEngineConfig>): AgentEngineConfig {
  return {
    model: 'anthropic/claude-sonnet-4.5',
    tools: {},
    conversationStore: new MemoryConversationStore(),
    conversationId: 'test-conv-1',
    ...overrides,
  }
}

async function collectEvents(engine: AgentEngine, input: string) {
  const events = []
  for await (const event of engine.run(input)) {
    events.push(event)
  }
  return events
}

describe('AgentEngine', () => {
  let mockStreamText: Mock

  beforeEach(async () => {
    vi.clearAllMocks()
    const ai = await import('ai')
    mockStreamText = ai.streamText as unknown as Mock
  })

  it('yields text-delta events from stream', async () => {
    mockStreamText.mockReturnValue(
      createMockStream(
        [
          { type: 'text-delta', text: 'Hello' },
          { type: 'text-delta', text: ' world' },
        ],
        { text: 'Hello world', usage: { inputTokens: 10, outputTokens: 5 } },
      ),
    )

    const engine = new AgentEngine(makeConfig())
    const events = await collectEvents(engine, 'Hi')

    const textDeltas = events.filter((e) => e.type === 'text-delta')
    expect(textDeltas).toHaveLength(2)
    expect(textDeltas[0]).toEqual({ type: 'text-delta', text: 'Hello' })
    expect(textDeltas[1]).toEqual({ type: 'text-delta', text: ' world' })
  })

  it('yields result event at the end', async () => {
    mockStreamText.mockReturnValue(
      createMockStream(
        [{ type: 'text-delta', text: 'Done' }],
        { text: 'Done', usage: { inputTokens: 8, outputTokens: 3 } },
      ),
    )

    const engine = new AgentEngine(makeConfig())
    const events = await collectEvents(engine, 'Test')

    const resultEvent = events.find((e) => e.type === 'result')
    expect(resultEvent).toBeDefined()
    expect(resultEvent!.type).toBe('result')
    expect((resultEvent as any).text).toBe('Done')
    expect((resultEvent as any).usage).toEqual({ inputTokens: 8, outputTokens: 3 })
    expect((resultEvent as any).durationMs).toBeGreaterThanOrEqual(0)
  })

  it('persists user message to store immediately', async () => {
    const store = new MemoryConversationStore()
    mockStreamText.mockReturnValue(
      createMockStream(
        [],
        { text: '', usage: { inputTokens: 1, outputTokens: 1 } },
      ),
    )

    const engine = new AgentEngine(makeConfig({ conversationStore: store }))
    await collectEvents(engine, 'Persist me')

    const messages = await store.loadAll('test-conv-1')
    expect(messages).not.toBeNull()
    const userMessages = messages!.filter((m) => m.role === 'user')
    expect(userMessages.length).toBeGreaterThanOrEqual(1)
    expect(userMessages[0].content).toBe('Persist me')
  })

  it('yields tool-call-start and tool-call-complete events', async () => {
    mockStreamText.mockReturnValue(
      createMockStream(
        [
          {
            type: 'tool-call',
            toolName: 'search',
            toolCallId: 'tc-1',
            input: { query: 'test' },
          },
          {
            type: 'tool-result',
            toolName: 'search',
            toolCallId: 'tc-1',
            input: { query: 'test' },
            output: { results: ['a', 'b'] },
          },
        ],
        { text: '', usage: { inputTokens: 15, outputTokens: 10 } },
      ),
    )

    const engine = new AgentEngine(makeConfig())
    const events = await collectEvents(engine, 'Search for me')

    const toolStart = events.find((e) => e.type === 'tool-call-start')
    expect(toolStart).toEqual({
      type: 'tool-call-start',
      toolName: 'search',
      toolCallId: 'tc-1',
    })

    const toolComplete = events.find((e) => e.type === 'tool-call-complete')
    expect(toolComplete).toEqual({
      type: 'tool-call-complete',
      toolName: 'search',
      toolCallId: 'tc-1',
      input: { query: 'test' },
      output: { results: ['a', 'b'] },
    })
  })

  it('yields error event on stream failure', async () => {
    mockStreamText.mockImplementation(() => {
      throw new Error('Stream failed')
    })

    const engine = new AgentEngine(makeConfig())
    const events = await collectEvents(engine, 'Fail')

    const errorEvent = events.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as any).error.message).toBe('Stream failed')
    expect((errorEvent as any).recoverable).toBe(false)
  })

  it('passes maxSteps via stopWhen to streamText', async () => {
    const { stepCountIs } = await import('ai')
    mockStreamText.mockReturnValue(
      createMockStream(
        [],
        { text: '', usage: { inputTokens: 1, outputTokens: 1 } },
      ),
    )

    const engine = new AgentEngine(makeConfig({ maxSteps: 10 }))
    await collectEvents(engine, 'Steps test')

    expect(stepCountIs).toHaveBeenCalledWith(10)
    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        stopWhen: { type: 'step-count', count: 10 },
      }),
    )
  })

  it('provides getMessages() and getUsage()', async () => {
    mockStreamText.mockReturnValue(
      createMockStream(
        [{ type: 'text-delta', text: 'Reply' }],
        { text: 'Reply', usage: { inputTokens: 5, outputTokens: 2 } },
      ),
    )

    const engine = new AgentEngine(makeConfig())
    await collectEvents(engine, 'Hello')

    const messages = engine.getMessages()
    expect(messages.length).toBeGreaterThanOrEqual(1)
    expect(messages[0]).toEqual({ role: 'user', content: 'Hello' })

    const usage = engine.getUsage()
    expect(usage).toEqual({ inputTokens: 5, outputTokens: 2 })
  })
})
