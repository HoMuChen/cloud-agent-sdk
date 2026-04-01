import { describe, it, expect } from 'vitest'
import { DefaultErrorHandler } from './DefaultErrorHandler.js'

describe('DefaultErrorHandler', () => {
  it('retries on rate limit with exponential backoff', async () => {
    const handler = new DefaultErrorHandler()
    const error = Object.assign(new Error('rate limited'), { status: 429 })

    const decision0 = await handler.handle(error, 0)
    expect(decision0).toEqual({ action: 'retry', delayMs: 1000 })

    const decision2 = await handler.handle(error, 2)
    expect(decision2).toEqual({ action: 'retry', delayMs: 4000 })
  })

  it('caps retry delay at 30 seconds', async () => {
    const handler = new DefaultErrorHandler()
    const error = Object.assign(new Error('rate limited'), { status: 429 })

    const decision = await handler.handle(error, 10)
    expect(decision.action).toBe('retry')
    if (decision.action === 'retry') {
      expect(decision.delayMs).toBeLessThanOrEqual(30000)
    }
  })

  it('retries on overloaded up to 3 times', async () => {
    const handler = new DefaultErrorHandler()
    const error = Object.assign(new Error('server overloaded'), { status: 529 })

    const d0 = await handler.handle(error, 0)
    expect(d0).toEqual({ action: 'retry', delayMs: 5000 })

    const d2 = await handler.handle(error, 2)
    expect(d2).toEqual({ action: 'retry', delayMs: 5000 })

    const d3 = await handler.handle(error, 3)
    expect(d3.action).not.toBe('retry')
  })

  it('falls back to another model when configured', async () => {
    const handler = new DefaultErrorHandler('openai/gpt-4o')
    const error = new Error('unknown error')

    const decision = await handler.handle(error, 0)
    expect(decision).toEqual({ action: 'fallback', model: 'openai/gpt-4o' })
  })

  it('aborts when no fallback', async () => {
    const handler = new DefaultErrorHandler()
    const error = new Error('unknown error')

    const decision = await handler.handle(error, 0)
    expect(decision).toEqual({ action: 'abort', message: 'unknown error' })
  })

  it('does not fallback more than once', async () => {
    const handler = new DefaultErrorHandler('openai/gpt-4o')
    const error = new Error('unknown error')

    const d0 = await handler.handle(error, 0)
    expect(d0).toEqual({ action: 'fallback', model: 'openai/gpt-4o' })

    const d2 = await handler.handle(error, 2)
    expect(d2).toEqual({ action: 'abort', message: 'unknown error' })
  })
})
