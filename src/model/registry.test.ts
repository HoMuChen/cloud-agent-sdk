import { describe, it, expect, vi } from 'vitest'
import type { LanguageModel } from 'ai'
import { ModelRegistry } from './registry.js'
import type { ProviderFactory } from './registry.js'

describe('ModelRegistry', () => {
  it('parses provider/model string correctly', () => {
    const registry = new ModelRegistry()
    const result = registry.parseModelString('anthropic/claude-sonnet-4.5')
    expect(result).toEqual({ provider: 'anthropic', modelId: 'claude-sonnet-4.5' })
  })

  it('throws on invalid model string (no slash)', () => {
    const registry = new ModelRegistry()
    expect(() => registry.parseModelString('invalid')).toThrow('Invalid model string')
  })

  it('throws on empty provider or model', () => {
    const registry = new ModelRegistry()
    expect(() => registry.parseModelString('/model')).toThrow('Invalid model string')
    expect(() => registry.parseModelString('provider/')).toThrow('Invalid model string')
  })

  it('resolves a registered provider', async () => {
    const registry = new ModelRegistry()
    const mockModel = { modelId: 'test-model' } as unknown as LanguageModel
    const factory: ProviderFactory = vi.fn().mockReturnValue(mockModel)

    registry.registerProvider('test', factory)
    const result = await registry.resolve('test/my-model')

    expect(factory).toHaveBeenCalledWith('my-model', undefined)
    expect(result).toBe(mockModel)
  })

  it('throws when provider is not registered and not installable', async () => {
    const registry = new ModelRegistry()
    await expect(registry.resolve('unknown/model')).rejects.toThrow(
      /Provider "unknown" is not registered/
    )
  })

  it('allows overriding a provider', async () => {
    const registry = new ModelRegistry()
    const firstModel = { modelId: 'first' } as unknown as LanguageModel
    const secondModel = { modelId: 'second' } as unknown as LanguageModel
    const firstFactory: ProviderFactory = vi.fn().mockReturnValue(firstModel)
    const secondFactory: ProviderFactory = vi.fn().mockReturnValue(secondModel)

    registry.registerProvider('custom', firstFactory)
    registry.registerProvider('custom', secondFactory)

    const result = await registry.resolve('custom/some-model')
    expect(secondFactory).toHaveBeenCalledWith('some-model', undefined)
    expect(result).toBe(secondModel)
    expect(firstFactory).not.toHaveBeenCalled()
  })
})
