/**
 * The production agent side of one distillation attempt.
 *
 * A recorded trajectory is only worth distilling if a real agent loop produced
 * it, so this runner drives the composed `agents`, `llm`, `tools`, and
 * `sessions` services rather than a stand-in. It creates one agent per attempt,
 * submits the task's prompt as an ordinary user message, waits for the turn to
 * settle, and flushes the session so every event it caused is committed before
 * the attempt is judged.
 *
 * The verdict is not this runner's decision: `runTask` judges the attempt with
 * the task's own evaluator, and the outcome returned here only distinguishes a
 * turn that completed from one that failed to run.
 *
 * @module @deepseek-ai/dsh-distill-app/agent-runner
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { TrajectoryCapture } from '@deepseek-ai/dsh-distill-trajectory-events'
import type { AttemptContext, AttemptOutcome, AgentRunner } from '@deepseek-ai/dsh-distill'

/** How the attempt's model is selected. */
export interface AgentRunnerOptions {
  /** The provider id, as the composition registered it. */
  readonly provider: string
  /** The model id the teacher lock requires. */
  readonly model: string
  /** The reasoning effort to request, when the provider takes one. */
  readonly reasoningEffort?: 'low' | 'high' | 'max'
  /** The response token ceiling for one request. */
  readonly maxTokens?: number
  /** Milliseconds one attempt may run before it is abandoned. */
  readonly attemptTimeoutMs?: number
  /** The composed capture that receives this attempt's live events. */
  readonly capture: TrajectoryCapture
}

/** Raised when an attempt exceeds its wall-clock budget. */
export class AttemptTimeoutError extends Error {
  /**
   * @param timeoutMs - the budget that was exceeded.
   */
  constructor(timeoutMs: number) {
    super(`the attempt did not finish within ${String(timeoutMs)} ms`)
    this.name = 'AttemptTimeoutError'
  }
}

/**
 * Reject when a promise does not settle inside a budget.
 * @param work - the attempt in flight.
 * @param timeoutMs - the budget, or `undefined` for no deadline.
 * @returns the promise's value once it settles.
 * @throws AttemptTimeoutError when the budget expires first.
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) return work
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new AttemptTimeoutError(timeoutMs)) }, timeoutMs)
  })
  try {
    return await Promise.race([work, expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Build the agent side of an attempt over a composed context.
 * @param ctx - the composed context, after the Loader has mounted every row.
 * @param options - the model selection, the attempt budget, and the capture.
 * @returns a runner `runTask` can drive.
 */
export function createAgentRunner(ctx: Context, options: AgentRunnerOptions): AgentRunner {
  return {
    async run(context: AttemptContext): Promise<AttemptOutcome> {
      // The recorder is bound to the attempt for exactly its lifetime, so one
      // attempt's live events never reach another attempt's log.
      const release = options.capture.bind(context.recorder)
      try {
        const { agent } = await ctx.agents.create({
          meta: { cwd: context.workspace },
          agentOptions: {
            provider: options.provider,
            model: options.model,
            ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
            ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
          },
        })
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: context.prompt }],
          source: { kind: 'user' },
        }))
        await withDeadline(agent.whenIdle(), options.attemptTimeoutMs)
        await ctx.sessions.flush(agent.session)
        return { status: 'SUCCESS', reason: 'the agent finished its turn' }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        // A turn that never ran measures nothing; the evaluator decides failure.
        return error instanceof AttemptTimeoutError
          ? { status: 'TIMEOUT', reason }
          : { status: 'ERROR', errorClass: 'infrastructure', reason }
      } finally {
        release()
      }
    },
  }
}
