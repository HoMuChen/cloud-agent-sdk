export class AgentError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'AgentError'
  }
}

export class BudgetExceededError extends AgentError {
  constructor(message = 'Budget exceeded') {
    super(message, 'BUDGET_EXCEEDED')
    this.name = 'BudgetExceededError'
  }
}

export class DurationExceededError extends AgentError {
  constructor(message = 'Duration exceeded') {
    super(message, 'DURATION_EXCEEDED')
    this.name = 'DurationExceededError'
  }
}
