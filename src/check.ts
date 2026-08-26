import { join } from 'path'
import * as core from '@actions/core'
import { PLAN_CHANGES, PLAN_ERROR, cannotSavePlan, runPlan } from '@core'
import type { PlanResult } from '@core'

/**
 * Deciding whether there are changes to apply.
 *
 * This is all that is specific to this action. Everything else — version
 * selection, credentials, backend init, workspace selection, masking — comes
 * from the shared core.
 */

export type CheckOutcome = 'no-changes' | 'changes-to-apply' | 'error'

export interface CheckResult {
  outcome: CheckOutcome
  /** Plan output, already masked. Safe to log. */
  output: string
  /** Errors from the failed plan, when the outcome is an error. */
  stderr: string
}

export interface CheckOptions {
  binary: string
  modulePath: string
  tempDir: string
  parallelism: string[]
  planArgs: string[]
  env?: NodeJS.ProcessEnv
}

/**
 * Plans without locking, and reads the outcome from the exit code.
 *
 * The lock is skipped because nothing is written: taking one would block a real
 * apply for no benefit. `-detailed-exitcode` is what makes the three outcomes
 * distinguishable — 2 means changes, which is the whole point of the action, and
 * must not be confused with 1, a plan that failed.
 */
export async function check(options: CheckOptions): Promise<CheckResult> {
  const planOut = join(options.tempDir, 'plan.out')

  let result = await runPlan({
    binary: options.binary,
    modulePath: options.modulePath,
    planOut,
    parallelism: options.parallelism,
    args: options.planArgs,
    lock: false,
    env: options.env,
  })

  // The remote backend cannot write a plan file at all. That is a limitation of
  // the backend rather than a problem with the configuration, so it is worth
  // retrying without one before reporting a failure.
  if (result.exitCode === PLAN_ERROR && cannotSavePlan(result.stderr)) {
    core.info('This backend does not support saving a plan; planning again without one.')
    result = await runPlan({
      binary: options.binary,
      modulePath: options.modulePath,
      parallelism: options.parallelism,
      args: options.planArgs,
      lock: false,
      env: options.env,
    })
  }

  return { outcome: outcomeOf(result), output: result.output, stderr: result.stderr }
}

function outcomeOf(result: PlanResult): CheckOutcome {
  if (result.exitCode === PLAN_ERROR) return 'error'
  if (result.exitCode === PLAN_CHANGES) return 'changes-to-apply'
  return 'no-changes'
}
