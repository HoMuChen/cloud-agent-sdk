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

function createMockStream(text = 'ok') {
  async function* generate() {
    yield { type: 'text-delta', text }
  }
  return {
    fullStream: generate(),
    text: Promise.resolve(text),
    totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
  }
}

function makeConfig(overrides?: Partial<AgentEngineConfig>): AgentEngineConfig {
  return {
    model: 'anthropic/claude-sonnet-4.5',
    tools: {},
    conversationStore: new MemoryConversationStore(),
    conversationId: 'test-multiturn',
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

describe('AgentEngine multi-turn conversation resume', () => {
  let mockStreamText: Mock

  beforeEach(async () => {
    vi.clearAllMocks()
    const ai = await import('ai')
    mockStreamText = ai.streamText as unknown as Mock
  })

  it('resumes conversation from store across engine instances', async () => {
    const store = new MemoryConversationStore()
    const convId = 'test-multiturn'

    // Turn 1: create engine1 with initialMessages=[], run('message-1'), consume
    mockStreamText.mockReturnValue(createMockStream('reply-1'))

    const engine1 = new AgentEngine(
      makeConfig({
        conversationStore: store,
        conversationId: convId,
        initialMessages: [],
      }),
    )
    await collectEvents(engine1, 'message-1')

    // Verify store has message-1
    const storedAfterTurn1 = await store.loadActive(convId)
    expect(storedAfterTurn1).not.toBeNull()
    const userMessages = storedAfterTurn1!.filter((m) => m.role === 'user')
    expect(userMessages.some((m) => m.content === 'message-1')).toBe(true)

    // Turn 2: create engine2 with initialMessages from store, run('message-2')
    mockStreamText.mockReturnValue(createMockStream('reply-2'))

    const loadedMessages = await store.loadActive(convId)
    const engine2 = new AgentEngine(
      makeConfig({
        conversationStore: store,
        conversationId: convId,
        initialMessages: loadedMessages!,
      }),
    )
    await collectEvents(engine2, 'message-2')

    // Verify streamText's messages array contains both 'message-1' and 'message-2'
    expect(mockStreamText).toHaveBeenCalledTimes(2)
    const turn2CallArgs = mockStreamText.mock.calls[1][0]
    const messageContents = turn2CallArgs.messages.map(
      (m: { content: string }) => m.content,
    )
    expect(messageContents).toContain('message-1')
    expect(messageContents).toContain('message-2')
  })
})
