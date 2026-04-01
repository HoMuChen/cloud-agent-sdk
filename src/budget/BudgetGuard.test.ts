import { describe, it, expect } from 'vitest'
import { BudgetGuard } from './BudgetGuard.js'

describe('BudgetGuard', () => {
  it('is not exceeded with zero usage', () => {
    const guard = new BudgetGuard({ maxBudgetUsd: 1.0 })
    const exceeded = guard.isExceeded({ inputTokens: 0, outputTokens: 0 }, 'anthropic/claude-sonnet-4.5')
    expect(exceeded).toBe(false)
  })

  it('detects when budget is exceeded', () => {
    const guard = new BudgetGuard({ maxBudgetUsd: 0.001 })
    const exceeded = guard.isExceeded(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'anthropic/claude-sonnet-4.5',
    )
    expect(exceeded).toBe(true)
  })

  it('returns not exceeded when no budget set', () => {
    const guard = new BudgetGuard({})
    const exceeded = guard.isExceeded(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'anthropic/claude-sonnet-4.5',
    )
    expect(exceeded).toBe(false)
  })

  it('detects duration exceeded', () => {
    const guard = new BudgetGuard({ maxDurationMs: 1_000 })
    const startTime = Date.now() - 2_000
    expect(guard.isDurationExceeded(startTime)).toBe(true)
  })

  it('duration not exceeded within limit', () => {
    const guard = new BudgetGuard({ maxDurationMs: 60_000 })
    const startTime = Date.now()
    expect(guard.isDurationExceeded(startTime)).toBe(false)
  })

  it('duration not exceeded when no limit set', () => {
    const guard = new BudgetGuard({})
    const startTime = Date.now() - 100_000
    expect(guard.isDurationExceeded(startTime)).toBe(false)
  })

  it('estimates cost correctly', () => {
    const guard = new BudgetGuard({})
    const cost = guard.estimateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'anthropic/claude-sonnet-4.5',
    )
    expect(cost).toBeGreaterThan(0)
  })
})
