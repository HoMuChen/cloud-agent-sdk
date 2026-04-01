import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { AgentEngine } from './AgentEngine.js'
import { MemoryConversationStore } from '../conversation/MemoryStore.js'
import type { AgentEngineConfig, AgentEvent, ResultEvent } from './types.js'

vi.mock('ai', () => ({
  streamText: vi.fn(),
  stepCountIs: vi.fn((n: number) => ({ type: 'step-count', count: n })),
}))

vi.mock('../model/registry.js', () => ({
  getDefaultRegistry: vi.fn().mockReturnValue({
    resolve: vi.fn().mockResolvedValue({ modelId: 'mock' }),
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
    conversationId: 'integration-conv-1',
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

const TOOL_STREAM_PARTS = [
  { type: 'text-delta', text: 'Let me check ' },
  {
    type: 'tool-call',
    toolCallId: 'tc-1',
    toolName: 'get_weather',
    input: { city: 'SF' },
  },
  {
    type: 'tool-result',
    toolCallId: 'tc-1',
    toolName: 'get_weather',
    input: { city: 'SF' },
    output: { temp: 65 },
  },
  { type: 'text-delta', text: 'The weather is 65F.' },
]

const FINAL_RESULT = {
  text: 'The weather is 65F.',
  usage: { inputTokens: 200, outputTokens: 80 },
}

describe('AgentEngine integration', () => {
  let mockStreamText: Mock

  beforeEach(async () => {
    vi.clearAllMocks()
    const ai = await import('ai')
    mockStreamText = ai.streamText as unknown as Mock
  })

  it('full turn: user input → stream with tool use → result + persistence', async () => {
    const store = new MemoryConversationStore()
    mockStreamText.mockReturnValue(
      createMockStream(TOOL_STREAM_PARTS, FINAL_RESULT),
    )

    const engine = new AgentEngine(
      makeConfig({ conversationStore: store }),
    )
    const events = await collectEvents(engine, 'What is the weather in SF?')

    // Verify event sequence contains the expected types in order
    const eventTypes = events.map((e) => e.type)
    expect(eventTypes).toContain('text-delta')
    expect(eventTypes).toContain('tool-call-start')
    expect(eventTypes).toContain('tool-call-complete')
    expect(eventTypes).toContain('result')

    // Verify ordering: text-delta before tool-call-start before tool-call-complete before result
    const firstTextDelta = eventTypes.indexOf('text-delta')
    const toolStart = eventTypes.indexOf('tool-call-start')
    const toolComplete = eventTypes.indexOf('tool-call-complete')
    const resultIdx = eventTypes.indexOf('result')
    expect(firstTextDelta).toBeLessThan(toolStart)
    expect(toolStart).toBeLessThan(toolComplete)
    expect(toolComplete).toBeLessThan(resultIdx)

    // Verify result text and usage
    const resultEvent = events.find((e) => e.type === 'result') as ResultEvent
    expect(resultEvent.text).toBe('The weather is 65F.')
    expect(resultEvent.usage).toEqual({ inputTokens: 200, outputTokens: 80 })

    // Verify store has user message
    const stored = await store.loadAll('integration-conv-1')
    expect(stored).not.toBeNull()
    const userMessages = stored!.filter((m) => m.role === 'user')
    expect(userMessages.length).toBeGreaterThanOrEqual(1)
    expect(userMessages[0].content).toBe('What is the weather in SF?')
  })

  it('generate() returns final result directly', async () => {
    mockStreamText.mockReturnValue(
      createMockStream(TOOL_STREAM_PARTS, FINAL_RESULT),
    )

    const engine = new AgentEngine(makeConfig())
    const result = await engine.generate('What is the weather in SF?')

    expect(result.type).toBe('result')
    expect(result.text).toBe('The weather is 65F.')
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 80 })
  })
})
