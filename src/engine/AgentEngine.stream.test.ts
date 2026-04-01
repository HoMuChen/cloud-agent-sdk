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
    conversationId: 'test-conv-stream',
    ...overrides,
  }
}

describe('AgentEngine.toUIMessageStreamResponse', () => {
  let mockStreamText: Mock

  beforeEach(async () => {
    vi.clearAllMocks()
    const ai = await import('ai')
    mockStreamText = ai.streamText as unknown as Mock
  })

  it('returns a Response object with correct content-type', async () => {
    mockStreamText.mockReturnValue(
      createMockStream(
        [{ type: 'text-delta', text: 'Hello' }],
        { text: 'Hello', usage: { inputTokens: 5, outputTokens: 2 } },
      ),
    )

    const engine = new AgentEngine(makeConfig())
    const response = await engine.toUIMessageStreamResponse('Hi')

    expect(response).toBeInstanceOf(Response)
    expect(response.headers.get('Content-Type')).toBe('text/event-stream')
    expect(response.headers.get('Cache-Control')).toBe('no-cache')
    expect(response.headers.get('Connection')).toBe('keep-alive')
  })

  it('response body is readable with at least 1 chunk', async () => {
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
    const response = await engine.toUIMessageStreamResponse('Hi')

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const chunks: string[] = []

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      chunks.push(decoder.decode(value, { stream: true }))
    }

    expect(chunks.length).toBeGreaterThanOrEqual(1)

    // Verify chunks are SSE formatted
    const allText = chunks.join('')
    expect(allText).toContain('data: ')
  })
})
