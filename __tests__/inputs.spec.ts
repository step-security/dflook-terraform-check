import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { InputError, loadInputs } from '../src/inputs.js'

let workspace: string

const INPUTS = [
  'INPUT_PATH',
  'INPUT_WORKSPACE',
  'INPUT_VARIABLES',
  'INPUT_VAR_FILE',
  'INPUT_BACKEND_CONFIG',
  'INPUT_BACKEND_CONFIG_FILE',
  'INPUT_PARALLELISM',
]

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'check-ws-'))
  process.env.GITHUB_WORKSPACE = workspace
  for (const name of INPUTS) delete process.env[name]
})

afterEach(() => {
  delete process.env.GITHUB_WORKSPACE
  for (const name of INPUTS) delete process.env[name]
})

describe('resolving path', () => {
  it('defaults to the workspace root', () => {
    expect(loadInputs().path).toBe(workspace)
  })

  it('resolves a subdirectory', () => {
    mkdirSync(join(workspace, 'infra'))
    process.env.INPUT_PATH = 'infra'
    expect(loadInputs().path).toBe(join(workspace, 'infra'))
  })

  it('rejects a path that does not exist', () => {
    process.env.INPUT_PATH = 'absent'
    expect(() => loadInputs()).toThrow(/Path does not exist: "absent"/)
  })

  it('rejects a file', () => {
    writeFileSync(join(workspace, 'main.tf'), '')
    process.env.INPUT_PATH = 'main.tf'
    expect(() => loadInputs()).toThrow(/is not a directory/)
  })
})

/**
 * path arrives from workflow input, so it must not be able to reach outside the
 * checkout even though the caller is usually trusted.
 */
describe('confining path to the workspace', () => {
  it.each([
    ['a parent traversal', '../elsewhere'],
    ['a nested traversal', 'infra/../../elsewhere'],
    ['an absolute path', '/etc'],
  ])('rejects %s', (_label, value) => {
    process.env.INPUT_PATH = value
    expect(() => loadInputs()).toThrow(InputError)
    expect(() => loadInputs()).toThrow(/stay inside the workspace/)
  })
})

describe('workspace', () => {
  it('defaults to default', () => {
    expect(loadInputs().workspace).toBe('default')
  })

  it('takes the given name', () => {
    process.env.INPUT_WORKSPACE = 'staging'
    expect(loadInputs().workspace).toBe('staging')
  })

  /** An empty value would ask Terraform to select a workspace with no name. */
  it('falls back to default when blank', () => {
    process.env.INPUT_WORKSPACE = '   '
    expect(loadInputs().workspace).toBe('default')
  })
})

describe('parallelism', () => {
  it('defaults to 0, leaving it to Terraform', () => {
    expect(loadInputs().parallelism).toBe('0')
  })

  it('takes the given limit', () => {
    process.env.INPUT_PARALLELISM = '5'
    expect(loadInputs().parallelism).toBe('5')
  })
})

/**
 * These carry HCL and path lists, so internal formatting is significant and has
 * to survive being read. Only wholly blank values count as absent.
 */
describe('block inputs', () => {
  it('keeps newlines in variables', () => {
    process.env.INPUT_VARIABLES = 'a = 1\nb = 2\n'
    expect(loadInputs().variables).toBe('a = 1\nb = 2\n')
  })

  it('keeps indentation, which HCL heredocs depend on', () => {
    process.env.INPUT_VARIABLES = 'a = <<EOT\n  indented\nEOT\n'
    expect(loadInputs().variables).toContain('  indented')
  })

  it.each([
    ['variables', 'INPUT_VARIABLES', 'variables'],
    ['var_file', 'INPUT_VAR_FILE', 'varFile'],
    ['backend_config', 'INPUT_BACKEND_CONFIG', 'backendConfig'],
    ['backend_config_file', 'INPUT_BACKEND_CONFIG_FILE', 'backendConfigFile'],
  ])('treats a blank %s as absent', (_label, variable, field) => {
    process.env[variable] = '  \n  '
    expect(loadInputs()[field as 'variables']).toBeUndefined()
  })

  it('reports an unset block input as undefined', () => {
    const inputs = loadInputs()
    expect(inputs.variables).toBeUndefined()
    expect(inputs.varFile).toBeUndefined()
    expect(inputs.backendConfig).toBeUndefined()
    expect(inputs.backendConfigFile).toBeUndefined()
  })
})
