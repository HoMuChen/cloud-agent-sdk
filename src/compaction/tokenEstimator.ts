import type { StoreMessage } from '../engine/types.js'

const CHARS_PER_TOKEN = 4

export function estimateTokens(input: string | StoreMessage[]): number {
  if (typeof input === 'string') {
    return Math.ceil(input.length / CHARS_PER_TOKEN)
  }
  if (input.length === 0) return 0
  const totalChars = input.reduce((sum, msg) => sum + msg.content.length + 16, 0)
  return Math.ceil(totalChars / CHARS_PER_TOKEN)
}
