import type { ContextBlock } from '../engine/types.js'

export interface PromptBuildParams {
  systemPrompt?: string
  tools: Record<string, any>
  resolvedContexts: ContextBlock[]
  instructions?: string[]
  maxSteps?: number
  maxBudgetUsd?: number
}

const DEFAULT_ROLE_PROMPT =
  'You are a helpful AI assistant. Answer questions and use tools to help the user.'

export class PromptBuilder {
  build(params: PromptBuildParams): string {
    const layers: string[] = []

    // 1. Role definition
    layers.push(params.systemPrompt ?? DEFAULT_ROLE_PROMPT)

    // 2. Tool guidance
    const toolNames = Object.keys(params.tools)
    if (toolNames.length > 0) {
      layers.push(
        [
          '# Available Tools',
          `You have ${toolNames.length} tools available: ${toolNames.join(', ')}.`,
          'Use them to answer the user\'s questions.',
          'Call multiple tools in parallel when they are independent of each other.',
          'If a tool call fails, analyze the error before retrying.',
        ].join('\n'),
      )
    }

    // 3. Context providers (system placement only, skip user-prefix)
    for (const ctx of params.resolvedContexts) {
      if (ctx.placement === 'system') {
        layers.push(ctx.content)
      }
    }

    // 4. Additional instructions
    if (params.instructions && params.instructions.length > 0) {
      layers.push(params.instructions.join('\n\n'))
    }

    // 5. Guardrails
    const guardrailLines: string[] = []
    if (params.maxSteps != null) {
      guardrailLines.push(`- Maximum steps: ${params.maxSteps}`)
    }
    if (params.maxBudgetUsd != null) {
      guardrailLines.push(`- Maximum budget: $${params.maxBudgetUsd}`)
    }
    if (guardrailLines.length > 0) {
      layers.push(['# Guardrails', ...guardrailLines].join('\n'))
    }

    return layers.filter(Boolean).join('\n\n')
  }
}
