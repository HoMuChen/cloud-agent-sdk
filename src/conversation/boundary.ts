import type { StoreMessage } from '../engine/types.js'

export function getMessagesAfterCompactBoundary(messages: StoreMessage[]): StoreMessage[] {
  let lastBoundaryIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'compact_boundary') {
      lastBoundaryIndex = i
      break
    }
  }
  if (lastBoundaryIndex === -1) return messages
  return messages.slice(lastBoundaryIndex)
}
