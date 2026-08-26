import { existsSync, statSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'

export class InputError extends Error {}

export interface Inputs {
  /** Root module to plan. */
  path: string
  /** Workspace to plan in. */
  workspace: string
  /** Literal tfvars content, overriding anything in `varFile`. */
  variables?: string
  /** Paths to tfvars files, relative to the workspace. */
  varFile?: string
  /** Backend `key=value` settings. */
  backendConfig?: string
  /** Paths to backend config files, relative to the workspace. */
  backendConfigFile?: string
  /** Concurrency limit, `0` to leave it to Terraform. */
  parallelism: string
  /** Workspace root that `path` was resolved against. */
  workspaceRoot: string
}

function read(name: string, fallback = ''): string {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim()
}

/** Reads an input, keeping internal formatting but dropping surrounding blank lines. */
function readBlock(name: string): string | undefined {
  const value = process.env[`INPUT_${name.toUpperCase()}`]
  if (value === undefined || !value.trim()) return undefined
  return value
}

/**
 * Builds the input set, resolving `path` against the runner workspace.
 *
 * Only `path` is validated here. The rest are checked where they are used, so
 * that a missing var file or backend config file is reported with the same
 * message upstream gives rather than a different one from here.
 */
export function loadInputs(): Inputs {
  const workspaceRoot = resolve(process.env.GITHUB_WORKSPACE || process.cwd())
  const requested = read('path', '.') || '.'
  const target = resolve(workspaceRoot, requested)

  // The path comes from workflow input and has no business pointing outside the
  // checkout, so confine it rather than trusting the caller.
  const offset = relative(workspaceRoot, target)
  if (offset.startsWith('..') || isAbsolute(offset)) {
    throw new InputError(
      `path must stay inside the workspace, but '${requested}' resolves outside it`
    )
  }

  if (!existsSync(target)) {
    throw new InputError(`Path does not exist: "${requested}"`)
  }
  if (!statSync(target).isDirectory()) {
    throw new InputError(`path '${requested}' is not a directory`)
  }

  return {
    path: target,
    workspace: read('workspace', 'default') || 'default',
    variables: readBlock('variables'),
    varFile: readBlock('var_file'),
    backendConfig: readBlock('backend_config'),
    backendConfigFile: readBlock('backend_config_file'),
    parallelism: read('parallelism', '0') || '0',
    workspaceRoot,
  }
}
