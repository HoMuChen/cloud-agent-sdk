import { describe, it, expect } from 'vitest'
import { staticProvider } from './staticProvider.js'

describe('staticProvider', () => {
  it('returns a ContextProvider with given content', async () => {
    const provider = staticProvider('my-ctx', 'hello world', 'system')
    expect(provider.name).toBe('my-ctx')
    const block = await provider.resolve({
      conversationId: 'conv-1',
      turnIndex: 0,
    })
    expect(block).toEqual({ content: 'hello world', placement: 'system' })
  })

  it('supports user-prefix placement', async () => {
    const provider = staticProvider('prefix', 'prefix content', 'user-prefix')
    const block = await provider.resolve({
      conversationId: 'conv-1',
      turnIndex: 0,
    })
    expect(block).not.toBeNull()
    expect(block!.placement).toBe('user-prefix')
  })
})
