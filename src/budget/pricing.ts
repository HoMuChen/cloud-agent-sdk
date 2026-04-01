interface ModelPricing { inputPerToken: number; outputPerToken: number }

const DEFAULT_PRICING: ModelPricing = {
  inputPerToken: 0.000003,
  outputPerToken: 0.000015,
}

const KNOWN_PRICING: Record<string, ModelPricing> = {
  'anthropic/claude-sonnet-4.5': { inputPerToken: 0.000003, outputPerToken: 0.000015 },
  'anthropic/claude-opus-4.5': { inputPerToken: 0.000015, outputPerToken: 0.000075 },
  'openai/gpt-4o': { inputPerToken: 0.0000025, outputPerToken: 0.00001 },
}

export function getModelPricing(model: string): ModelPricing {
  return KNOWN_PRICING[model] ?? DEFAULT_PRICING
}
