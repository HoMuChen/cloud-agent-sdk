import { streamText, stepCountIs } from 'ai'
import type { LanguageModel } from 'ai'
import { getDefaultRegistry } from '../model/registry.js'
import { PromptBuilder } from '../prompt/PromptBuilder.js'
import type {
  AgentEngineConfig,
  AgentEvent,
  ContextBlock,
  ResultEvent,
  StoreMessage,
  TokenUsage,
} from './types.js'
import { BudgetExceededError, DurationExceededError } from './errors.js'

export class AgentEngine {
  private messages: StoreMessage[]
  private totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  private promptBuilder = new PromptBuilder()

  constructor(private readonly config: AgentEngineConfig) {
    this.messages = config.initialMessages ? [...config.initialMessages] : []
  }

  async *run(
    input: string,
    options?: { abortSignal?: AbortSignal },
  ): AsyncGenerator<AgentEvent> {
    const startTime = Date.now()

    try {
      // Resolve model (async)
      const model: LanguageModel = await getDefaultRegistry().resolve(this.config.model)

      // Resolve context providers
      const resolvedContexts: ContextBlock[] = []
      if (this.config.contextProviders && this.config.contextProviders.length > 0) {
        const results = await Promise.allSettled(
          this.config.contextProviders.map((p) =>
            p.resolve({
              conversationId: this.config.conversationId,
              turnIndex: this.messages.length,
            }),
          ),
        )
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value) {
            resolvedContexts.push(result.value)
          }
        }
      }

      // Append user message and persist immediately
      const userMessage: StoreMessage = { role: 'user', content: input }
      this.messages.push(userMessage)
      await this.config.conversationStore.append(this.config.conversationId, [userMessage])

      // Build system prompt
      const system = this.promptBuilder.build({
        systemPrompt: this.config.systemPrompt,
        tools: this.config.tools,
        resolvedContexts,
        instructions: this.config.instructions,
        maxSteps: this.config.maxSteps,
        maxBudgetUsd: this.config.maxBudgetUsd,
      })

      // Prepend user-prefix contexts to last user message content
      const userPrefixContexts = resolvedContexts.filter((c) => c.placement === 'user-prefix')
      let messages = this.messages.map((m) => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content }))
      if (userPrefixContexts.length > 0 && messages.length > 0) {
        const lastIdx = messages.length - 1
        const prefixContent = userPrefixContexts.map((c) => c.content).join('\n\n')
        messages = [
          ...messages.slice(0, lastIdx),
          { ...messages[lastIdx], content: `${prefixContent}\n\n${messages[lastIdx].content}` },
        ]
      }

      // Call streamText
      const abortSignal = options?.abortSignal ?? this.config.abortSignal
      const result = streamText({
        model,
        system,
        messages,
        tools: this.config.tools,
        stopWhen: stepCountIs(this.config.maxSteps ?? 25),
        ...(abortSignal ? { abortSignal } : {}),
      })

      // Iterate fullStream parts and map to AgentEvents
      for await (const part of result.fullStream) {
        // Check budget/duration on each part
        if (this.config.maxDurationMs != null) {
          const elapsed = Date.now() - startTime
          if (elapsed > this.config.maxDurationMs) {
            throw new DurationExceededError()
          }
        }

        if (part.type === 'text-delta') {
          yield { type: 'text-delta', text: part.text } satisfies AgentEvent
        } else if (part.type === 'tool-call') {
          // Check onToolCall hook
          if (this.config.onToolCall) {
            const decision = await this.config.onToolCall({
              toolName: part.toolName,
              toolCallId: part.toolCallId,
              input: part.input,
            })
            if (decision.action === 'deny') {
              yield {
                type: 'tool-call-complete',
                toolName: part.toolName,
                toolCallId: part.toolCallId,
                input: part.input,
                output: `DENIED: ${decision.reason}`,
              } satisfies AgentEvent
              continue
            }
          }
          yield {
            type: 'tool-call-start',
            toolName: part.toolName,
            toolCallId: part.toolCallId,
          } satisfies AgentEvent
        } else if (part.type === 'tool-result') {
          yield {
            type: 'tool-call-complete',
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            input: part.input,
            output: part.output,
          } satisfies AgentEvent
        }
        // All other part types: skip
      }

      // Await final result for usage (in AI SDK v5, these are Promises)
      const [finalText, finalTotalUsage] = await Promise.all([
        result.text,
        result.totalUsage,
      ])
      const usage: TokenUsage = {
        inputTokens: finalTotalUsage?.inputTokens ?? 0,
        outputTokens: finalTotalUsage?.outputTokens ?? 0,
      }
      this.totalUsage.inputTokens += usage.inputTokens
      this.totalUsage.outputTokens += usage.outputTokens

      const durationMs = Date.now() - startTime

      // Persist assistant response
      if (finalText) {
        const assistantMessage: StoreMessage = { role: 'assistant', content: finalText }
        this.messages.push(assistantMessage)
        await this.config.conversationStore.append(this.config.conversationId, [assistantMessage])
      }

      yield {
        type: 'result',
        text: finalText,
        usage,
        durationMs,
      } satisfies ResultEvent
    } catch (error) {
      yield {
        type: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
        recoverable: false,
      } satisfies AgentEvent
    }
  }

  async generate(input: string): Promise<ResultEvent> {
    let lastResult: ResultEvent | undefined
    for await (const event of this.run(input)) {
      if (event.type === 'result') {
        lastResult = event
      }
    }
    if (!lastResult) {
      throw new Error('No result event produced')
    }
    return lastResult
  }

  async toUIMessageStreamResponse(
    input: string,
    options?: { metadata?: Record<string, unknown> },
  ): Promise<Response> {
    const encoder = new TextEncoder()
    const generator = this.run(input)

    const stream = new ReadableStream({
      async pull(controller) {
        const { value, done } = await generator.next()
        if (done) {
          controller.close()
          return
        }
        const data = JSON.stringify(value)
        controller.enqueue(encoder.encode(`data: ${data}\n\n`))
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  }

  getMessages(): readonly StoreMessage[] {
    return [...this.messages]
  }

  getUsage(): TokenUsage {
    return { ...this.totalUsage }
  }
}
