import type { ConversationStore, StoreMessage } from '../engine/types.js'
import { getMessagesAfterCompactBoundary } from './boundary.js'

export class MemoryConversationStore implements ConversationStore {
  private store = new Map<string, StoreMessage[]>()

  async append(conversationId: string, messages: StoreMessage[]): Promise<void> {
    const existing = this.store.get(conversationId) ?? []
    const copied = messages.map(m => structuredClone(m))
    this.store.set(conversationId, [...existing, ...copied])
  }

  async loadAll(conversationId: string): Promise<StoreMessage[] | null> {
    const messages = this.store.get(conversationId)
    if (!messages) return null
    return messages.map(m => structuredClone(m))
  }

  async loadActive(conversationId: string): Promise<StoreMessage[] | null> {
    const all = this.store.get(conversationId)
    if (!all) return null
    const active = getMessagesAfterCompactBoundary(all)
    return active.map(m => structuredClone(m))
  }
}
