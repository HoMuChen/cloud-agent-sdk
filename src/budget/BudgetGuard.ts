import type { TokenUsage } from '../engine/types.js'
import { getModelPricing } from './pricing.js'

export interface BudgetGuardConfig { maxBudgetUsd?: number; maxDurationMs?: number }

export class BudgetGuard {
  constructor(private config: BudgetGuardConfig) {}

  isExceeded(usage: TokenUsage, model: string): boolean {
    if (!this.config.maxBudgetUsd) return false
    return this.estimateCost(usage, model) > this.config.maxBudgetUsd
  }

  isDurationExceeded(startTime: number): boolean {
    if (!this.config.maxDurationMs) return false
    return (Date.now() - startTime) > this.config.maxDurationMs
  }

  estimateCost(usage: TokenUsage, model: string): number {
    const p = getModelPricing(model)
    return usage.inputTokens * p.inputPerToken + usage.outputTokens * p.outputPerToken
  }
}
