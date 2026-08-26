import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { check } from '../src/check.js'

/**
 * A stand-in for the tool binary. Terraform carries its result in the exit code
 * — 0 no changes, 1 failed, 2 changes to apply — so that is what these vary.
 */
function fakeTool(exitCode: number, stdout = '', stderr = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-tool-'))
  const path = join(dir, 'fake-tool')
  const script = [
    '#!/bin/bash',
    'echo "$@" >> "$0.args"',
    stdout ? `cat <<'STDOUT'\n${stdout}\nSTDOUT` : '',
    stderr ? `cat >&2 <<'STDERR'\n${stderr}\nSTDERR` : '',
    `exit ${exitCode}`,
  ]
    .filter(Boolean)
    .join('\n')
  writeFileSync(path, `${script}\n`, { mode: 0o755 })
  return path
}

function options(binary: string) {
  return {
    binary,
    modulePath: mkdtempSync(join(tmpdir(), 'check-module-')),
    tempDir: mkdtempSync(join(tmpdir(), 'check-tmp-')),
    parallelism: [],
    planArgs: [],
  }
}

describe('reading the outcome from the exit code', () => {
  it('reports no changes on 0', async () => {
    const result = await check(options(fakeTool(0)))
    expect(result.outcome).toBe('no-changes')
  })

  /**
   * The distinction that matters most. Treating 1 as changes would report a
   * broken configuration as a normal "there are changes" outcome.
   */
  it('reports an error on 1', async () => {
    const result = await check(options(fakeTool(1, '', 'Error: invalid provider')))
    expect(result.outcome).toBe('error')
    expect(result.stderr).toContain('invalid provider')
  })

  it('reports changes on 2', async () => {
    const result = await check(options(fakeTool(2, 'Plan: 1 to add')))
    expect(result.outcome).toBe('changes-to-apply')
  })
})

describe('the plan invocation', () => {
  it('asks for a detailed exit code, or the outcome is unknowable', async () => {
    const binary = fakeTool(0)
    await check(options(binary))
    const args = require('fs').readFileSync(`${binary}.args`, 'utf8')
    expect(args).toContain('-detailed-exitcode')
  })

  /** Nothing is written, so taking a lock would block a real apply for no gain. */
  it('does not take a state lock', async () => {
    const binary = fakeTool(0)
    await check(options(binary))
    const args = require('fs').readFileSync(`${binary}.args`, 'utf8')
    expect(args).toContain('-lock=false')
  })

  it('saves a plan file', async () => {
    const binary = fakeTool(0)
    await check(options(binary))
    const args = require('fs').readFileSync(`${binary}.args`, 'utf8')
    expect(args).toMatch(/-out=\S*plan\.out/)
  })
})

/**
 * The remote backend cannot write a plan file. That is a property of the
 * backend, not a broken configuration, so it is retried without one rather than
 * reported as a failure.
 */
describe('a backend that cannot save a plan', () => {
  it('retries without a plan file and uses the second result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-retry-'))
    const path = join(dir, 'fake-tool')
    writeFileSync(
      path,
      [
        '#!/bin/bash',
        'echo "$@" >> "$0.args"',
        'if [[ "$*" == *-out=* ]]; then',
        '  echo "Error: Saving a generated plan is currently not supported" >&2',
        '  exit 1',
        'fi',
        'echo "Plan: 1 to add, 0 to change, 0 to destroy."',
        'exit 2',
      ].join('\n'),
      { mode: 0o755 }
    )

    const result = await check(options(path))
    expect(result.outcome).toBe('changes-to-apply')

    const args = require('fs').readFileSync(`${path}.args`, 'utf8').trim().split('\n')
    expect(args).toHaveLength(2)
    expect(args[1]).not.toContain('-out=')
  })

  it('does not retry an ordinary failure', async () => {
    const binary = fakeTool(1, '', 'Error: Invalid provider configuration')
    const result = await check(options(binary))

    expect(result.outcome).toBe('error')
    const args = require('fs').readFileSync(`${binary}.args`, 'utf8').trim().split('\n')
    expect(args).toHaveLength(1)
  })
})

/**
 * Plan output reaches the job log, so it goes through the same redaction
 * upstream applies. Verified here so a change to the plumbing cannot quietly
 * drop it.
 */
describe('redacting the plan output', () => {
  it('masks a sensitive value before returning it', async () => {
    const result = await check(options(fakeTool(2, '        api_key = "s3cr3t-value"')))

    expect(result.output).not.toContain('s3cr3t-value')
    expect(result.output).toContain('api_key = "************"')
  })

  it('leaves an ordinary value readable', async () => {
    const result = await check(options(fakeTool(2, '        instance_type = "t3.micro"')))
    expect(result.output).toContain('t3.micro')
  })
})
