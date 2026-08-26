import { mkdirSync, mkdtempSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import * as core from '@actions/core'
import {
  acquire,
  backendConfigArgs,
  candidateVersions,
  deleteAutoTfVars,
  getBackendType,
  getOpenTofuVersions,
  getTerraformVersions,
  initBackendWorkspace,
  loadModule,
  planArgs,
  resolveVersion,
  runPreRunCommands,
  writeAutoTfVars,
  writeCredentials,
} from '@core'
import { InputError, loadInputs } from './inputs.js'
import type { Inputs } from './inputs.js'
import { check } from './check.js'
import { validateSubscription } from './subscription.js'

const CHANGES_TO_APPLY = 'changes-to-apply'

/**
 * Publishes why the step failed.
 *
 * Both spellings are set because the documented contract carries the hyphenated
 * and the underscored name, and consumers depend on either one.
 */
function setFailureReason(reason: string): void {
  core.setOutput('failure-reason', reason)
  core.setOutput('failure_reason', reason)
}

/** True when OpenTofu should be used instead of Terraform. */
function openTofuRequested(): boolean {
  return process.env.OPENTOFU_VERSION !== undefined || process.env.OPENTOFU === 'true'
}

interface Prepared {
  binary: string
  env: NodeJS.ProcessEnv
  dataDir: string
  tempDir: string
  backendType?: string
}

/**
 * Installs the tool and prepares the environment.
 *
 * The ordering here is upstream's and matters in two places: the tool is
 * installed before `TERRAFORM_PRE_RUN` runs, so a pre-run command can rely on it
 * existing; and `TF_WORKSPACE` is cleared, because inheriting one from the job
 * environment would silently plan against a different workspace than the
 * `workspace` input names.
 */
async function prepare(inputs: Inputs): Promise<Prepared> {
  const tempDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'terraform-check-'))
  const dataDir = join(tempDir, 'terraform-data-dir')
  const pluginCache = join(homedir(), '.terraform.d', 'plugin-cache')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(pluginCache, { recursive: true })

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TF_DATA_DIR: dataDir,
    TF_PLUGIN_CACHE_DIR: pluginCache,
    TF_IN_AUTOMATION: 'true',
  }
  // A workspace inherited from the job would override the input.
  delete env.TF_WORKSPACE

  if (!env.TERRAFORM_ACTIONS_GITHUB_TOKEN && env.GITHUB_TOKEN) {
    env.TERRAFORM_ACTIONS_GITHUB_TOKEN = env.GITHUB_TOKEN
  }

  writeCredentials({
    cloudTokens: process.env.TERRAFORM_CLOUD_TOKENS,
    httpCredentials: process.env.TERRAFORM_HTTP_CREDENTIALS,
    sshKey: process.env.TERRAFORM_SSH_KEY,
  })

  const openTofu = openTofuRequested()
  const module = loadModule(inputs.path, openTofu)
  const terraform = await getTerraformVersions()
  const tofu = openTofu ? await getOpenTofuVersions(process.env.GITHUB_TOKEN) : undefined

  const resolution = resolveVersion(
    { modulePath: inputs.path, workspaceRoot: inputs.workspaceRoot, openTofu },
    { module, versions: candidateVersions(terraform, tofu), env: process.env }
  )

  if (!resolution) {
    throw new Error(
      openTofu
        ? 'No OpenTofu release matched. A pre-release has to be named exactly, e.g. OPENTOFU_VERSION=1.6.0-alpha3'
        : 'No Terraform release matched the version constraints in effect'
    )
  }

  core.info(
    `Using ${resolution.version.product} ${resolution.version} because ${resolution.reason}`
  )
  const binary = await acquire(resolution.version)

  const backendType = getBackendType(module)
  if (backendType) core.info(`Detected ${backendType} backend`)

  await runPreRunCommands(process.env.TERRAFORM_PRE_RUN)

  return { binary, env, dataDir, tempDir, backendType }
}

export async function run(): Promise<number> {
  await validateSubscription()

  let inputs: Inputs
  try {
    inputs = loadInputs()
  } catch (error) {
    if (error instanceof InputError) {
      core.error(error.message)
      return 1
    }
    throw error
  }

  let prepared: Prepared | undefined

  try {
    prepared = await prepare(inputs)

    // These are copied into the module directory, so they have to be removed
    // again whatever happens below.
    writeAutoTfVars(
      { variables: inputs.variables, varFile: inputs.varFile },
      inputs.path,
      inputs.workspaceRoot
    )

    const initResult = await initBackendWorkspace({
      binary: prepared.binary,
      modulePath: inputs.path,
      workspace: inputs.workspace,
      backendConfigArgs: backendConfigArgs(
        {
          backendConfig: inputs.backendConfig,
          backendConfigFile: inputs.backendConfigFile,
        },
        { modulePath: inputs.path, workspaceRoot: inputs.workspaceRoot }
      ),
      dataDir: prepared.dataDir,
      env: prepared.env,
      backendType: prepared.backendType,
    })

    const env = initResult.tfWorkspace
      ? { ...prepared.env, TF_WORKSPACE: initResult.tfWorkspace }
      : prepared.env

    const { parallelism, args } = planArgs({ parallelism: inputs.parallelism })

    const result = await check({
      binary: prepared.binary,
      modulePath: inputs.path,
      tempDir: prepared.tempDir,
      parallelism,
      planArgs: args,
      env,
    })

    if (result.outcome === 'error') {
      core.error('Error running Terraform')
      if (result.stderr.trim()) core.error(result.stderr.trimEnd())
      return 1
    }

    if (result.outcome === CHANGES_TO_APPLY) {
      core.error('Changes detected!')
      setFailureReason(CHANGES_TO_APPLY)
      return 1
    }

    core.info('No changes to apply.')
    return 0
  } catch (error) {
    core.error(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    if (prepared) deleteAutoTfVars(inputs.path)
  }
}

/**
 * Only self-start when invoked directly, so the module can still be imported by
 * a test. `import.meta.url` is the ESM equivalent of the `require.main` check.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  run()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      core.setFailed(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
