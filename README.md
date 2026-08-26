[![StepSecurity Maintained Action](https://raw.githubusercontent.com/step-security/maintained-actions-assets/main/assets/maintained-action-banner.png)](https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions)

# terraform-check action

A StepSecurity maintained drop-in replacement for [dflook/terraform-check](https://github.com/dflook/terraform-check), with
the same inputs and outputs.

Runs `terraform plan` and fails the job if anything is still waiting to be
applied. Useful on a schedule to notice when real infrastructure has drifted from
what the configuration says.

Nothing is written and no state lock is taken, so it is safe to run alongside a
real apply.

## Usage

```yaml
name: Check for drift

on:
  schedule:
    - cron: "0 7 * * *"

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - name: Check for drift
        uses: step-security/dflook-terraform-check@v3
        with:
          path: infra
```

To act on drift specifically rather than on any failure, test the output:

```yaml
      - name: Check for drift
        id: check
        uses: step-security/dflook-terraform-check@v3
        with:
          path: infra

      - name: Warn about drift
        if: failure() && steps.check.outputs.failure-reason == 'changes-to-apply'
        run: echo "Infrastructure has drifted from the configuration"
```

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `path` | `.` | Directory holding the root module to plan. |
| `workspace` | `default` | Workspace to select before planning. |
| `variables` | | Variable definitions in Terraform syntax, as in a tfvars file. |
| `var_file` | | Paths to tfvars files, one per line, relative to the workspace. |
| `backend_config` | | Backend settings as `key=value`, one per line. |
| `backend_config_file` | | Paths to backend config files, one per line, relative to the workspace. |
| `parallelism` | `0` | Maximum concurrent operations. `0` leaves the limit to Terraform. |

### Variables

`variables` and `var_file` are both written into the module as auto-loaded
`.tfvars` files, so they apply to every command rather than only the one this
action runs directly. They are named so that `variables` loads last, which is
what makes it override `var_file`:

```yaml
      - uses: step-security/dflook-terraform-check@v3
        with:
          var_file: |
            common.tfvars
            production.tfvars
          variables: |
            image_id = "${{ secrets.AMI_ID }}"
            availability_zones = ["eu-west-1a", "eu-west-1b"]
```

The generated files are removed when the step finishes, including if it fails, so
they cannot leak into a later step or an uploaded artifact.

A `var_file` path that does not exist fails the job rather than being skipped
quietly, since a plan built without values you meant to supply is not the plan
you asked for.

### Backend configuration

`backend_config_file` is applied first, then `backend_config`, so an inline value
overrides a file. Paths are given relative to the workspace and rewritten
internally, because `init` runs with the module as its working directory.

```yaml
      - uses: step-security/dflook-terraform-check@v3
        with:
          backend_config_file: production.backend.tfvars
          backend_config: token=${{ secrets.BACKEND_TOKEN }}
```

## Outputs

| Name | Value |
| --- | --- |
| `failure_reason` | `changes-to-apply` when the job failed because changes are outstanding. |
| `failure-reason` | Hyphenated spelling of the same value. |

Both spellings are published, so either name works.

This is set **only** when the failure is outstanding changes. A plan that fails
for any other reason — an invalid configuration, an unreachable backend — fails
the job without setting it. That makes
`failure-reason == 'changes-to-apply'` a reliable test for drift rather than for
failure in general.

## Terraform version

The version to run is worked out from your configuration, using the first of
these that applies:

1. a `required_version` constraint in the Terraform configuration
2. a `.tfswitchrc` file
3. an `.opentofu-version` file
4. a `.terraform-version` file
5. a `terraform` entry in `.tool-versions` (asdf), searching upwards to the workspace root
6. the `TERRAFORM_VERSION` environment variable
7. the version recorded in local state, when state has been written
8. otherwise, the latest release

Configuration beats environment deliberately. `required_version` describes what
the code needs, so a workflow-wide `TERRAFORM_VERSION` default does not silently
override a module that pins something narrower. Every run logs which version it
chose and why.

Most of these accept a constraint rather than an exact version, so `~> 1.5`
resolves to the newest matching release. A pre-release is only ever selected when
named exactly, so `~> 1.6` will not give you `1.6.0-alpha1`.

```yaml
      - uses: step-security/dflook-terraform-check@v3
        env:
          TERRAFORM_VERSION: 1.9.8
```

Set `OPENTOFU_VERSION`, or `OPENTOFU: true`, to use OpenTofu instead. When
OpenTofu is selected, Terraform releases below `1.6.0` are excluded, since that is
where the projects diverge.

Downloads are compared against the published `SHA256SUMS` before being extracted,
and cached in the runner tool cache, so a repeated version costs no network.

## Redacting plan output

The plan is printed to the job log, so values under attribute names that look
like credentials are replaced with `*` first. Resource types that exist to hold
generated secrets — `random_id`, `kubernetes_secret`, `acme_certificate` — have
their ids masked too.

This matches the redaction the upstream action applies, including its limits,
which are worth knowing:

- It works on **attribute names**, not on Terraform's own `sensitive` marking, so
  a sensitive value under an innocuous name is not masked.
- The pattern requires a non-alphabetic character before the keyword, so
  `db_password` is masked but a bare `password` is not.

Treat it as a safety net rather than the reason it is safe to print a plan. Set
`TFMASK_VALUES_REGEX` to apply a stricter pattern of your own.

## Environment variables

| Name | Purpose |
| --- | --- |
| `TERRAFORM_VERSION` | Version or constraint to run. See above for where it sits in precedence. |
| `OPENTOFU_VERSION` / `OPENTOFU` | Use OpenTofu instead of Terraform. |
| `GITHUB_DOT_COM_TOKEN` | Token for github.com when running on GitHub Enterprise, used only to download OpenTofu releases. Without it the download is unauthenticated and may be rate limited. |
| `TERRAFORM_CLOUD_TOKENS` | `host=token` pairs, one per line, for the `remote` backend and the module registry. |
| `TERRAFORM_HTTP_CREDENTIALS` | `host=user:password` pairs, one per line, for fetching modules over HTTP or `git::https`. Evaluated in order; the first match wins. |
| `TERRAFORM_SSH_KEY` | PEM-format private key for fetching modules over SSH. |
| `TERRAFORM_PRE_RUN` | Shell commands to run after Terraform is installed and before it is used. |
| `TFMASK_VALUES_REGEX` | Overrides which attribute names have their values masked. |
| `TF_PLAN_COLLAPSE_LENGTH` | Line count above which plan output is collapsed. |

```yaml
      - uses: step-security/dflook-terraform-check@v3
        env:
          TERRAFORM_CLOUD_TOKENS: app.terraform.io=${{ secrets.TF_CLOUD_TOKEN }}
          TERRAFORM_SSH_KEY: ${{ secrets.TERRAFORM_SSH_KEY }}
```

`TERRAFORM_PRE_RUN` runs with `-x`, `-e` and `-o pipefail`, so it stops at the
first failing command rather than continuing into Terraform with a half-prepared
environment. Workflow commands are suspended while it runs, so a line of its
output cannot masquerade as an instruction to the runner:

```yaml
        env:
          TERRAFORM_PRE_RUN: |
            apt-get update
            apt-get install -y jq
```

## Development

Version resolution, downloading, backend init, workspace selection, plan
execution and output redaction are shared with the sibling Terraform actions
through
[`dflook-terraform-actions-core`](https://github.com/step-security/dflook-terraform-actions-core),
included here as a submodule at `vendor/core`. Only the check itself lives in this
repository. The submodule is bundled into `dist/` at build time, so consumers of
the action never need to fetch it.

```bash
git clone --recurse-submodules https://github.com/step-security/dflook-terraform-check.git
npm ci
npm test
npm run build   # regenerates dist/, which is committed
```

An existing clone needs `git submodule update --init` once, or the build cannot
resolve `@core`.

If a test suite fails to parse with `Cannot use import statement outside a
module`, the ts-jest cache is stale — `npx jest --clearCache` fixes it. CI starts
from a clean cache and is unaffected.
