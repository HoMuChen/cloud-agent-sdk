import type { LanguageModel } from 'ai'

export type ProviderFactory = (modelId: string) => LanguageModel

const BUILTIN_PROVIDERS = ['anthropic', 'openai', 'google'] as const
const BUILTIN_PACKAGE_MAP: Record<string, string> = {
  anthropic: '@ai-sdk/anthropic',
  openai: '@ai-sdk/openai',
  google: '@ai-sdk/google',
}

export class ModelRegistry {
  private providers = new Map<string, ProviderFactory>()

  parseModelString(model: string): { provider: string; modelId: string } {
    const slashIndex = model.indexOf('/')
    if (slashIndex === -1) {
      throw new Error('Invalid model string: must be in "provider/model-id" format')
    }
    const provider = model.slice(0, slashIndex)
    const modelId = model.slice(slashIndex + 1)
    if (!provider || !modelId) {
      throw new Error('Invalid model string: provider and model ID must not be empty')
    }
    return { provider, modelId }
  }

  registerProvider(name: string, factory: ProviderFactory): void {
    this.providers.set(name, factory)
  }

  async resolve(model: string): Promise<LanguageModel> {
    const { provider, modelId } = this.parseModelString(model)

    let factory: ProviderFactory | undefined = this.providers.get(provider)
    if (!factory) {
      factory = (await this.tryLoadBuiltinProvider(provider)) ?? undefined
    }
    if (!factory) {
      throw new Error(`Provider "${provider}" is not registered and could not be loaded`)
    }

    return factory(modelId)
  }

  async tryLoadBuiltinProvider(name: string): Promise<ProviderFactory | null> {
    const packageName = BUILTIN_PACKAGE_MAP[name]
    if (!packageName) {
      return null
    }

    try {
      const mod = await import(packageName)
      const providerFn = mod[name]
      if (typeof providerFn === 'function') {
        const factory: ProviderFactory = (modelId: string) => providerFn(modelId)
        this.providers.set(name, factory)
        return factory
      }
      return null
    } catch {
      return null
    }
  }
}

let defaultRegistry: ModelRegistry | null = null

export function getDefaultRegistry(): ModelRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new ModelRegistry()
  }
  return defaultRegistry
}
