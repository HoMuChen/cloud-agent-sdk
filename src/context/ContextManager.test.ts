import { describe, it, expect, vi } from 'vitest'
import { ContextManager } from './ContextManager.js'
import type { ContextProvider, ContextResolveParams } from '../engine/types.js'

const baseParams: ContextResolveParams = {
  conversationId: 'conv-1',
  turnIndex: 0,
}

describe('ContextManager', () => {
  it('resolves all providers in parallel', async () => {
    const providers: ContextProvider[] = [
      {
        name: 'a',
        resolve: async () => ({ content: 'block-a', placement: 'system' as const }),
      },
      {
        name: 'b',
        resolve: async () => ({ content: 'block-b', placement: 'user-prefix' as const }),
      },
    ]
    const manager = new ContextManager(providers)
    const blocks = await manager.resolveAll(baseParams)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ content: 'block-a', placement: 'system' })
    expect(blocks[1]).toEqual({ content: 'block-b', placement: 'user-prefix' })
  })

  it('skips providers that return null', async () => {
    const providers: ContextProvider[] = [
      {
        name: 'good',
        resolve: async () => ({ content: 'ok', placement: 'system' as const }),
      },
      {
        name: 'empty',
        resolve: async () => null,
      },
    ]
    const manager = new ContextManager(providers)
    const blocks = await manager.resolveAll(baseParams)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].content).toBe('ok')
  })

  it('skips providers that throw errors', async () => {
    const providers: ContextProvider[] = [
      {
        name: 'good',
        resolve: async () => ({ content: 'ok', placement: 'system' as const }),
      },
      {
        name: 'broken',
        resolve: async () => { throw new Error('boom') },
      },
    ]
    const manager = new ContextManager(providers)
    const blocks = await manager.resolveAll(baseParams)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].content).toBe('ok')
  })

  it('returns empty array for no providers', async () => {
    const manager = new ContextManager([])
    const blocks = await manager.resolveAll(baseParams)
    expect(blocks).toEqual([])
  })

  it('passes context params to providers', async () => {
    const resolveFn = vi.fn().mockResolvedValue({ content: 'x', placement: 'system' as const })
    const providers: ContextProvider[] = [{ name: 'spy', resolve: resolveFn }]
    const params: ContextResolveParams = {
      conversationId: 'conv-42',
      turnIndex: 3,
      userId: 'user-1',
      metadata: { foo: 'bar' },
    }
    const manager = new ContextManager(providers)
    await manager.resolveAll(params)
    expect(resolveFn).toHaveBeenCalledWith(params)
  })
})
