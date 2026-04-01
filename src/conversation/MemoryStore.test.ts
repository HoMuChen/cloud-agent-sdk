import { describe, it, expect } from 'vitest'
import { MemoryConversationStore } from './MemoryStore.js'
import type { StoreMessage } from '../engine/types.js'

const boundary: StoreMessage = {
  role: 'system',
  content: '[Compact Boundary]',
  type: 'compact_boundary',
  metadata: {
    trigger: 'auto',
    compactedMessageCount: 5,
    preCompactTokenCount: 1000,
    postCompactTokenCount: 200,
    timestamp: new Date(),
  },
}

describe('MemoryConversationStore', () => {
  it('returns null for unknown conversation', async () => {
    const store = new MemoryConversationStore()
    expect(await store.loadAll('unknown')).toBeNull()
    expect(await store.loadActive('unknown')).toBeNull()
  })

  it('appends and loads messages', async () => {
    const store = new MemoryConversationStore()
    const messages: StoreMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]
    await store.append('conv1', messages)
    const loaded = await store.loadAll('conv1')
    expect(loaded).toEqual(messages)
  })

  it('appends incrementally', async () => {
    const store = new MemoryConversationStore()
    await store.append('conv1', [{ role: 'user', content: 'First' }])
    await store.append('conv1', [{ role: 'assistant', content: 'Second' }])
    const loaded = await store.loadAll('conv1')
    expect(loaded).toEqual([
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Second' },
    ])
  })

  it('loadActive returns all when no boundary', async () => {
    const store = new MemoryConversationStore()
    const messages: StoreMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]
    await store.append('conv1', messages)
    const active = await store.loadActive('conv1')
    const all = await store.loadAll('conv1')
    expect(active).toEqual(all)
  })

  it('loadActive returns messages after last compact boundary', async () => {
    const store = new MemoryConversationStore()
    const messages: StoreMessage[] = [
      { role: 'user', content: 'Old message 1' },
      { role: 'assistant', content: 'Old response 1' },
      boundary,
      { role: 'system', content: 'Summary of previous conversation' },
      { role: 'user', content: 'New message' },
      { role: 'assistant', content: 'New response' },
    ]
    await store.append('conv1', messages)
    const active = await store.loadActive('conv1')
    expect(active).toEqual([
      boundary,
      { role: 'system', content: 'Summary of previous conversation' },
      { role: 'user', content: 'New message' },
      { role: 'assistant', content: 'New response' },
    ])
  })

  it('loadActive uses the LAST boundary when multiple exist', async () => {
    const store = new MemoryConversationStore()
    const secondBoundary: StoreMessage = {
      ...boundary,
      metadata: { ...boundary.metadata!, compactedMessageCount: 10 },
    }
    const messages: StoreMessage[] = [
      { role: 'user', content: 'Very old' },
      boundary,
      { role: 'system', content: 'First summary' },
      { role: 'user', content: 'Old message' },
      { role: 'assistant', content: 'Old response' },
      secondBoundary,
      { role: 'system', content: 'Second summary' },
      { role: 'user', content: 'Latest message' },
      { role: 'assistant', content: 'Latest response' },
    ]
    await store.append('conv1', messages)
    const active = await store.loadActive('conv1')
    expect(active).toEqual([
      secondBoundary,
      { role: 'system', content: 'Second summary' },
      { role: 'user', content: 'Latest message' },
      { role: 'assistant', content: 'Latest response' },
    ])
    expect(active).toHaveLength(4)
  })

  it('does not mutate stored messages', async () => {
    const store = new MemoryConversationStore()
    const messages: StoreMessage[] = [
      { role: 'user', content: 'Original' },
    ]
    await store.append('conv1', messages)

    // Mutate the source array
    messages[0].content = 'Mutated'

    const loaded = await store.loadAll('conv1')
    expect(loaded![0].content).toBe('Original')
  })
})
