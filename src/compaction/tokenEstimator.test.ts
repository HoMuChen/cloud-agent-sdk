import { describe, it, expect } from 'vitest'
import { estimateTokens } from './tokenEstimator.js'

describe('estimateTokens', () => {
  it('estimates tokens for a string', () => {
    const tokens = estimateTokens('Hello, this is a test string for token estimation.')
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(100)
  })

  it('estimates tokens for messages array', () => {
    const tokens = estimateTokens([
      { role: 'user', content: 'Hello there' },
      { role: 'assistant', content: 'Hi! How can I help you today?' },
    ])
    expect(tokens).toBeGreaterThan(0)
  })

  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens([])).toBe(0)
  })

  it('longer text produces more tokens', () => {
    const short = estimateTokens('short')
    const long = estimateTokens('This is a much longer string that should produce significantly more tokens than the short one.')
    expect(long).toBeGreaterThan(short)
  })
})
