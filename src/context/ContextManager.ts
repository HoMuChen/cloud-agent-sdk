import type { ContextProvider, ContextBlock, ContextResolveParams } from '../engine/types.js'

export class ContextManager {
  constructor(private providers: ContextProvider[]) {}

  async resolveAll(params: ContextResolveParams): Promise<ContextBlock[]> {
    if (this.providers.length === 0) return []

    const results = await Promise.allSettled(
      this.providers.map(provider => provider.resolve(params))
    )

    const blocks: ContextBlock[] = []
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        blocks.push(result.value)
      }
    }
    return blocks
  }
}
