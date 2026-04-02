export class AgentError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'AgentError'
  }
}

export class DurationExceededError extends AgentError {
  constructor(message = 'Duration exceeded') {
    super(message, 'DURATION_EXCEEDED')
    this.name = 'DurationExceededError'
  }
}
