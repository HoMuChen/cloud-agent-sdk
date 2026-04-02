import { describe, it, expect } from 'vitest'
import { PromptBuilder } from './PromptBuilder.js'
import type { PromptBuildParams } from './PromptBuilder.js'
import type { ContextBlock } from '../engine/types.js'

describe('PromptBuilder', () => {
  const builder = new PromptBuilder()

  it('builds with just systemPrompt', () => {
    const result = builder.build({
      systemPrompt: 'You are a coding assistant.',
      tools: {},
      resolvedContexts: [],
    })
    expect(result).toContain('You are a coding assistant.')
  })

  it('uses default role prompt when no systemPrompt', () => {
    const result = builder.build({
      tools: {},
      resolvedContexts: [],
    })
    expect(result).toContain('You are a helpful AI assistant')
  })

  it('includes tool guidance when tools provided', () => {
    const result = builder.build({
      tools: { get_weather: {}, search_docs: {} },
      resolvedContexts: [],
    })
    expect(result).toContain('2 tools available')
    expect(result).toContain('get_weather')
    expect(result).toContain('search_docs')
  })

  it('includes system-placement context blocks', () => {
    const contexts: ContextBlock[] = [
      { content: 'System context here.', placement: 'system' },
      { content: 'User prefix context.', placement: 'user-prefix' },
    ]
    const result = builder.build({
      tools: {},
      resolvedContexts: contexts,
    })
    expect(result).toContain('System context here.')
    expect(result).not.toContain('User prefix context.')
  })

  it('includes instructions', () => {
    const result = builder.build({
      tools: {},
      resolvedContexts: [],
      instructions: ['Use Traditional Chinese.', 'Be concise.'],
    })
    expect(result).toContain('Use Traditional Chinese.')
    expect(result).toContain('Be concise.')
  })

  it('includes guardrails when steps set', () => {
    const result = builder.build({
      tools: {},
      resolvedContexts: [],
      maxSteps: 10,
    })
    expect(result).toContain('10')
  })

  it('assembles all layers in order', () => {
    const result = builder.build({
      systemPrompt: 'ROLE_MARKER',
      tools: { mytool: {} },
      resolvedContexts: [{ content: 'CONTEXT_MARKER', placement: 'system' }],
      instructions: ['INSTRUCTION_MARKER'],
      maxSteps: 5,
    })
    const roleIdx = result.indexOf('ROLE_MARKER')
    const toolIdx = result.indexOf('Available Tools')
    const contextIdx = result.indexOf('CONTEXT_MARKER')
    const instructionIdx = result.indexOf('INSTRUCTION_MARKER')

    expect(roleIdx).toBeLessThan(toolIdx)
    expect(toolIdx).toBeLessThan(contextIdx)
    expect(contextIdx).toBeLessThan(instructionIdx)
  })
})
