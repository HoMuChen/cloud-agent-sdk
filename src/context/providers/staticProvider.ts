import type { ContextProvider, ContextBlock } from '../../engine/types.js'

export function staticProvider(
  name: string,
  content: string,
  placement: ContextBlock['placement']
): ContextProvider {
  return {
    name,
    resolve: async () => ({ content, placement }),
  }
}
