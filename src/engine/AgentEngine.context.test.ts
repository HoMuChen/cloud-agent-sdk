import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { AgentEngine } from './AgentEngine.js'
import { MemoryConversationStore } from '../conversation/MemoryStore.js'
import type { AgentEngineConfig, ContextProvider, AgentEvent } from './types.js'

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
    conversationId: 'test-ctx-conv',
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

describe('AgentEngine context integration', () => {
  let mockStreamText: Mock

  beforeEach(async () => {
    vi.clearAllMocks()
    const ai = await import('ai')
    mockStreamText = ai.streamText as unknown as Mock
  })

  it('resolves context providers and includes system context in prompt', async () => {
    const provider: ContextProvider = {
      name: 'test-context',
      resolve: vi.fn().mockResolvedValue({
        content: 'INJECTED_CONTEXT',
        placement: 'system',
      }),
    }

    mockStreamText.mockReturnValue(createMockStream())

    const engine = new AgentEngine(
      makeConfig({ contextProviders: [provider] }),
    )
    await collectEvents(engine, 'hello')

    expect(mockStreamText).toHaveBeenCalledTimes(1)
    const callArgs = mockStreamText.mock.calls[0][0]
    expect(callArgs.system).toContain('INJECTED_CONTEXT')
  })

  it('skips failed context providers gracefully', async () => {
    const goodProvider: ContextProvider = {
      name: 'good-provider',
      resolve: vi.fn().mockResolvedValue({
        content: 'GOOD',
        placement: 'system',
      }),
    }

    const badProvider: ContextProvider = {
      name: 'bad-provider',
      resolve: vi.fn().mockRejectedValue(new Error('provider failed')),
    }

    mockStreamText.mockReturnValue(createMockStream())

    const engine = new AgentEngine(
      makeConfig({ contextProviders: [goodProvider, badProvider] }),
    )
    const events = await collectEvents(engine, 'hello')

    // Run completes with a result event
    const resultEvent = events.find((e) => e.type === 'result')
    expect(resultEvent).toBeDefined()
    expect(resultEvent!.type).toBe('result')

    // System prompt contains the good provider's content
    expect(mockStreamText).toHaveBeenCalledTimes(1)
    const callArgs = mockStreamText.mock.calls[0][0]
    expect(callArgs.system).toContain('GOOD')
  })
})
