import { describe, it, expect, vi } from 'vitest'
import type { LanguageModel } from 'ai'
import type { StoreMessage, TokenUsage } from '../engine/types.js'

vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({ text: 'Summary of conversation.' }),
}))

import { ThresholdCompactionStrategy } from './ThresholdCompaction.js'

describe('ThresholdCompactionStrategy', () => {
  const makeMessages = (count: number): StoreMessage[] =>
    Array.from({ length: count }, (_, i) => ({
      role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `Message ${i + 1}`,
    }))

  const mockModel = {} as LanguageModel

  it('shouldCompact returns false when under threshold', () => {
    const strategy = new ThresholdCompactionStrategy({ contextWindow: 100000, threshold: 0.75 })
    const usage: TokenUsage = { inputTokens: 40000, outputTokens: 20000 } // 60000 < 75000
    expect(strategy.shouldCompact([], usage)).toBe(false)
  })

  it('shouldCompact returns true when over threshold', () => {
    const strategy = new ThresholdCompactionStrategy({ contextWindow: 100000, threshold: 0.75 })
    const usage: TokenUsage = { inputTokens: 50000, outputTokens: 30000 } // 80000 > 75000
    expect(strategy.shouldCompact([], usage)).toBe(true)
  })

  it('compact preserves recent messages and summarizes old ones', async () => {
    const strategy = new ThresholdCompactionStrategy({ keepRecentMessages: 6 })
    const messages = makeMessages(12)

    const result = await strategy.compact(messages, mockModel)

    // boundary + summaryUser + summaryAck + 6 kept = 9
    expect(result.activeMessages).toHaveLength(9)
    expect(result.activeMessages[0].type).toBe('compact_boundary')
    expect(result.compactedCount).toBe(6)
    expect(result.summary).toBe('Summary of conversation.')
    expect(result.appendMessages).toHaveLength(3)
  })

  it('compact returns as-is if too few messages', async () => {
    const strategy = new ThresholdCompactionStrategy({ keepRecentMessages: 6 })
    const messages = makeMessages(2)

    const result = await strategy.compact(messages, mockModel)

    expect(result.activeMessages).toEqual(messages)
    expect(result.compactedCount).toBe(0)
    expect(result.summary).toBe('')
    expect(result.freedTokens).toBe(0)
  })
})
