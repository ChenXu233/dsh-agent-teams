import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { minimumHost } from './compatibility.mjs'
import { hostVerification, runtimeTargets, requiredRuntimeScenarios, validateRuntimeReport, validateRuntimeReports } from './harness-validation.mjs'
import { runPluginInstallation } from './harness-runtime-scenarios.mjs'

const PLUGIN_NAME = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name
const futureVersion = '0.2.1-rc.999' // Fictional regression input, never a support claim.
const hosts = [minimumHost(), futureVersion]
const expected = { pluginVersion: '0.1.26', artifactSha256: 'a'.repeat(64) }
function reportFor(target) {
  return { passed: true, version: target.host, platform: target.os === 'windows-latest' ? 'win32' : 'linux', ...expected,
    runs: [...requiredRuntimeScenarios, 'plugin-manager-install'].map(scenario => ({ scenario, passed: true })) }
}

test('every requested host receives both platforms and a required install probe', () => {
  assert.deepEqual(runtimeTargets([futureVersion]), [
    { host: futureVersion, os: 'ubuntu-latest' }, { host: futureVersion, os: 'windows-latest' },
  ])
  // A host above the floor has no exemption: it must still exercise the plugin-manager install.
  assert.equal(hostVerification(futureVersion).pluginManagerInstall, true)
  for (const target of runtimeTargets(hosts)) {
    const withoutInstall = { ...reportFor(target), runs: reportFor(target).runs.filter(run => run.scenario !== 'plugin-manager-install') }
    assert.throws(() => validateRuntimeReport(withoutInstall, target, expected, hosts), /plugin-manager-install/)
    assert.doesNotThrow(() => validateRuntimeReport(reportFor(target), target, expected, hosts))
  }
})

test('the floor and any extra host both expand to the same platform plan', () => {
  for (const host of [minimumHost(), futureVersion]) {
    for (const os of ['ubuntu-latest', 'windows-latest']) assert.ok(runtimeTargets(hosts).some(target => target.host === host && target.os === os))
  }
  assert.deepEqual(runtimeTargets(), runtimeTargets([minimumHost()]), 'the floor is the default matrix')
  for (const version of ['latest', '*', futureVersion + '\n']) assert.throws(() => hostVerification(version), /exact host/)
  for (const invalid of [[], 'latest', [futureVersion + '\n']]) assert.throws(() => runtimeTargets(invalid))
})

test('missing scenarios, failed runs, wrong platform or a different candidate cannot pass', () => {
  const target = { host: futureVersion, os: 'windows-latest' }
  const valid = reportFor(target)
  for (const scenario of [...requiredRuntimeScenarios, 'plugin-manager-install']) {
    assert.throws(() => validateRuntimeReport({ ...valid, runs: valid.runs.filter(run => run.scenario !== scenario) }, target, expected, hosts), new RegExp(scenario))
  }
  for (const change of [{ passed: false }, { version: '0.2.1-rc.3' }, { platform: 'linux' }, { pluginVersion: 'old' }, { artifactSha256: 'b'.repeat(64) }, { runs: [...valid.runs, { scenario: 'extra', passed: false }] }]) {
    assert.throws(() => validateRuntimeReport({ ...valid, ...change }, target, expected, hosts))
  }
  // A report for a host that was not requested is not part of this run's plan.
  assert.throws(() => validateRuntimeReport(valid, { host: '0.2.0', os: 'windows-latest' }, expected, hosts), /not in the verification plan/)
})

test('collection consumes the same host plan and refuses missing Windows evidence', t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const target of runtimeTargets(hosts)) {
    const directory = join(root, `harness-${target.os}-${target.host}`)
    mkdirSync(directory)
    writeFileSync(join(directory, 'result.json'), JSON.stringify(reportFor(target)))
  }
  assert.equal(validateRuntimeReports(root, expected, hosts), runtimeTargets(hosts).length)
  rmSync(join(root, `harness-windows-latest-${futureVersion}`, 'result.json'))
  assert.throws(() => validateRuntimeReports(root, expected, hosts), /ENOENT/)
})

test('real installation entry is invoked for every host, including the floor and unknown candidates', async t => {
  const report = mkdtempSync(join(tmpdir(), 'harness-install-'))
  t.after(() => rmSync(report, { recursive: true, force: true }))
  let calls = 0
  let exit = 0
  let installedVersion = expected.pluginVersion
  let timedOut = false
  const options = { version: futureVersion, pluginVersion: expected.pluginVersion, artifact: join(report, 'candidate.tgz'), runtime: join(report, 'runtime'), report, environment: extra => extra,
    async command(argv, cwd, env, label) {
      calls++
      assert.equal(label, 'plugin-manager-install')
      assert.deepEqual(argv.slice(2), ['plugin', '--profile', 'web', 'add', '--save-exact', options.artifact])
      const installed = join(env.DSH_HOME, 'profiles/web/node_modules', PLUGIN_NAME)
      mkdirSync(installed, { recursive: true })
      writeFileSync(join(installed, 'package.json'), JSON.stringify({ version: installedVersion }))
      return { code: exit, timedOut }
    } }
  assert.equal((await runPluginInstallation(options))[0].passed, true)
  exit = 1
  assert.equal((await runPluginInstallation(options))[0].passed, false, 'A leftover package must not hide CLI rejection')
  exit = 0; installedVersion = '0.1.15'
  assert.equal((await runPluginInstallation(options))[0].passed, false)
  installedVersion = expected.pluginVersion; timedOut = true
  assert.equal((await runPluginInstallation(options))[0].passed, false)
  assert.equal(calls, 4)
  // The floor host is not exempt either: it runs the same install probe.
  timedOut = false
  assert.equal((await runPluginInstallation({ ...options, version: minimumHost() }))[0].passed, true)
  assert.equal(calls, 5)
})
