import type { ErrorHandler, ErrorDecision } from '../engine/types.js'

export class DefaultErrorHandler implements ErrorHandler {
  constructor(private fallbackModel?: string) {}

  async handle(error: Error, attempt: number): Promise<ErrorDecision> {
    if (this.isRateLimitError(error)) {
      return { action: 'retry', delayMs: Math.min(1000 * Math.pow(2, attempt), 30000) }
    }
    if (this.isOverloadedError(error) && attempt < 3) {
      return { action: 'retry', delayMs: 5000 }
    }
    if (this.fallbackModel && attempt < 2) {
      return { action: 'fallback', model: this.fallbackModel }
    }
    return { action: 'abort', message: error.message }
  }

  private isRateLimitError(error: Error): boolean {
    return (error as any).status === 429 || error.message.toLowerCase().includes('rate limit')
  }

  private isOverloadedError(error: Error): boolean {
    return (error as any).status === 529 || (error as any).status === 503 || error.message.toLowerCase().includes('overloaded')
  }
}
