#!/usr/bin/env node
/**
 * The single verification entry point.
 *
 * Every check the release gate depends on is declared here as data: a script to run,
 * or a list of test files for `node --test`. Phases run in order and stop at the first
 * failure, so a red run points at one named phase instead of a 700-character shell chain.
 *
 * Requires a prior `pnpm build` (lib/ present). Never touches a running DSH profile.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const node = process.execPath

/** `script` phases run one Node script; `tests` phases run `node --test` over an explicit file list. */
const phases = [
  { name: 'source smoke', script: 'scripts/verify.mjs' },
  { name: 'fallback tdd', script: 'scripts/fallback-tdd.mjs' },
  { name: 'member failure tdd', script: 'scripts/member-failure-tdd.mjs' },
  { name: 'quality gates logic', script: 'scripts/quality-gates-tdd.mjs' },
  { name: 'lifecycle', script: 'scripts/lifecycle-verify.mjs' },
  { name: 'stress', script: 'scripts/stress-verify.mjs' },
  { name: 'web routes', script: 'scripts/web-routes-verify.mjs' },
  { name: 'readme version', script: 'scripts/readme-version.mjs' },
  { name: 'skill sync', script: 'scripts/sync-skill.mjs', args: ['--check'] },
  { name: 'compatibility policy', script: 'scripts/compatibility.mjs' },
  { name: 'doctor', script: 'scripts/doctor.mjs' },
  { name: 'git artifacts', script: 'scripts/git-artifacts.mjs' },
  { name: 'harness compatibility', script: 'scripts/harness-compat-tdd.mjs' },
  { name: 'stability seams', script: 'scripts/stability-tdd.mjs' },
  { name: 'lifecycle (modern harness)', script: 'scripts/lifecycle-verify.mjs', args: ['--modern-harness'] },
  { name: 'member failure (modern harness)', script: 'scripts/member-failure-tdd.mjs', args: ['--modern-harness'] },
  { name: 'lifecycle (delivery harness)', script: 'scripts/lifecycle-verify.mjs', args: ['--delivery-harness'] },
  { name: 'member failure (delivery harness)', script: 'scripts/member-failure-tdd.mjs', args: ['--delivery-harness'] },
  { name: 'unit: regression issues', tests: [
    'scripts/issue-188.test.mjs', 'scripts/issue-189.test.mjs', 'scripts/issue-205.test.mjs',
    'scripts/issue-234.test.mjs', 'scripts/issue-236.test.mjs', 'scripts/issue-236-stale-module.test.mjs',
    'scripts/issue-262.test.mjs',
  ] },
  { name: 'unit: quality gates', tests: [
    'scripts/quality-gates-repair-scope.test.mjs', 'scripts/quality-gates-amend.test.mjs',
    'scripts/quality-gates-content-bound.test.mjs', 'scripts/quality-gates-work-order.test.mjs',
    'scripts/quality-gates-repair-wiring.test.mjs', 'scripts/quality-gates-excluded-scope.test.mjs',
    'scripts/quality-gates-cross-binding.test.mjs',
  ] },
  { name: 'unit: members', tests: [
    'scripts/member-spawn-recovery.test.mjs', 'scripts/verify-run-command.test.mjs',
    'scripts/verify-member-residency.test.mjs', 'scripts/verify-member-address.test.mjs',
    'scripts/verify-member-command.test.mjs', 'scripts/verify-member-remote.test.mjs',
    'scripts/verify-member-route-registry.test.mjs', 'scripts/verify-member-controls.test.mjs',
    'scripts/verify-deny-normalize.test.mjs', 'scripts/member-context-budget.test.mjs',
  ] },
  { name: 'unit: runtime', tests: [
    'scripts/issue-159.test.mjs', 'scripts/issue-203-card.test.mjs', 'scripts/corrupt-teamjson.test.mjs',
    'scripts/http-body.test.mjs', 'scripts/capabilities.test.mjs', 'scripts/tool-policies.test.mjs',
    'scripts/archive-delete.test.mjs',
    'scripts/lineage-identity.test.mjs', 'scripts/legacy-session-source-repair.test.mjs',
    'scripts/harness-source-verify.test.mjs', 'scripts/git-artifacts.test.mjs',
  ] },
  { name: 'unit: workspace audit', tests: ['scripts/issue-336.test.mjs'] },
  { name: 'unit: release metadata', tests: [
    'scripts/release-metadata.test.mjs', 'scripts/readme-version.test.mjs',
    'scripts/compatibility.test.mjs', 'scripts/harness-validation.test.mjs', 'scripts/upgrade-status.test.mjs',
  ] },
  { name: 'unit: client harness', tests: [
    'scripts/client-harness-migration.test.mjs', 'scripts/workspace-activity.test.mjs', 'scripts/workspace-summary.test.mjs',
  ] },
]

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status ?? 1
}

function main() {
  if (!existsSync(new URL('../lib/index.js', import.meta.url))) {
    console.error('verify: lib/ is missing; run "pnpm build" first.')
    return 2
  }
  const started = Date.now()
  let executed = 0
  for (const [index, phase] of phases.entries()) {
    const label = `[${index + 1}/${phases.length}] ${phase.name}`
    const argv = phase.tests ? [...phase.tests] : [phase.script, ...(phase.args ?? [])]
    const command = phase.tests ? [node, '--test', ...argv] : [node, ...argv]
    console.log(`
=== ${label} ===`)
    const status = run(command[0], command.slice(1))
    if (status !== 0) {
      console.error(`
verify: FAILED at ${label} (exit ${status})`)
      return status
    }
    executed++
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`
verify: ${executed}/${phases.length} phases passed in ${seconds}s`)
  return 0
}

process.exitCode = main()
