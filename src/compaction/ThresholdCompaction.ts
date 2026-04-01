import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import type { CompactionStrategy, CompactionResult, StoreMessage, TokenUsage } from '../engine/types.js'
import { estimateTokens } from './tokenEstimator.js'

export interface ThresholdCompactionConfig {
  threshold?: number       // 0-1, default 0.75
  contextWindow?: number   // default 200000
  keepRecentMessages?: number // default 6
}

export class ThresholdCompactionStrategy implements CompactionStrategy {
  private threshold: number
  private contextWindow: number
  private keepRecent: number

  constructor(config: ThresholdCompactionConfig = {}) {
    this.threshold = config.threshold ?? 0.75
    this.contextWindow = config.contextWindow ?? 200000
    this.keepRecent = config.keepRecentMessages ?? 6
  }

  shouldCompact(_messages: StoreMessage[], usage: TokenUsage): boolean {
    const totalTokens = usage.inputTokens + usage.outputTokens
    return totalTokens > this.contextWindow * this.threshold
  }

  async compact(messages: StoreMessage[], model: LanguageModel): Promise<CompactionResult> {
    if (messages.length <= this.keepRecent) {
      return { activeMessages: messages, appendMessages: [], summary: '', freedTokens: 0, compactedCount: 0 }
    }

    const toCompact = messages.slice(0, -this.keepRecent)
    const toKeep = messages.slice(-this.keepRecent)

    const formatted = toCompact.map(m => `${m.role}: ${m.content}`).join('\n')
    const { text: summary } = await generateText({
      model,
      prompt: `Summarize this conversation concisely, preserving key facts, decisions, and context needed for continuation:\n\n${formatted}`,
    })

    const boundary: StoreMessage = {
      role: 'system',
      content: '[Compact Boundary]',
      type: 'compact_boundary',
      metadata: {
        trigger: 'auto',
        compactedMessageCount: toCompact.length,
        preCompactTokenCount: estimateTokens(messages),
        postCompactTokenCount: estimateTokens(summary) + estimateTokens(toKeep),
        timestamp: new Date(),
      },
    }

    const summaryUser: StoreMessage = { role: 'user', content: `[Previous conversation summary]\n${summary}` }
    const summaryAck: StoreMessage = { role: 'assistant', content: 'Understood. I have the context from our previous conversation.' }

    const activeMessages = [boundary, summaryUser, summaryAck, ...toKeep]
    const appendMessages = [boundary, summaryUser, summaryAck]

    return {
      activeMessages,
      appendMessages,
      summary,
      freedTokens: estimateTokens(toCompact) - estimateTokens(summary),
      compactedCount: toCompact.length,
    }
  }
}
