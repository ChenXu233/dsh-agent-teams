/** Shared execution plan and acceptance rules for real-host verification. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { minimumHost, policy, validatePackageCompatibility } from './compatibility.mjs'

export const requiredRuntimeScenarios = [
  'lifecycle', 'lifecycle-cold-restore', 'fallback', 'fallback-cold-restore',
  'failure', 'captain-idle-wakeup', 'progressive-entry', 'web-approval',
  'protocol-compatibility', 'stability',
]

const exactVersion = version => typeof version === 'string' && version.trim() === version
  && /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(version)

/**
 * Every host named by the caller gets the full suite on both CI platforms, including the
 * plugin-manager install probe. There is no per-host exemption table: the floor is tested like
 * any other host, and nothing else is pinned.
 */
export function hostVerification(version) {
  if (!exactVersion(version)) throw new Error('Verification requires an exact host version')
  return { platforms: ['ubuntu-latest', 'windows-latest'], pluginManagerInstall: true }
}

export function runtimeTargets(hosts = [minimumHost()]) {
  if (!Array.isArray(hosts) || hosts.length === 0) throw new Error('At least one host version is required')
  return hosts.flatMap(host => hostVerification(host).platforms.map(os => ({ host, os })))
}

export function validateRuntimeReport(report, target, expected, hosts) {
  const { host, os } = target
  assert.ok(runtimeTargets(hosts).some(t => t.host === host && t.os === os), 'Report target is not in the verification plan')
  assert.equal(report.passed, true, `Host ${host} did not pass`)
  assert.equal(report.version, host)
  assert.equal(report.platform, os === 'windows-latest' ? 'win32' : 'linux')
  assert.equal(report.pluginVersion, expected.pluginVersion)
  assert.equal(report.artifactSha256, expected.artifactSha256)
  assert.ok(Array.isArray(report.runs) && report.runs.length > 0 && report.runs.every(run => run.passed === true), `Host ${host} lacks successful functional evidence`)
  const required = [...requiredRuntimeScenarios, ...(hostVerification(host).pluginManagerInstall ? ['plugin-manager-install'] : [])]
  for (const scenario of required) {
    assert.ok(report.runs.some(run => run.scenario === scenario && run.passed === true), `Host ${host} did not exercise ${scenario}`)
  }
}

export function validateRuntimeReports(directory, expected, hosts) {
  const targets = runtimeTargets(hosts)
  for (const target of targets) {
    const report = JSON.parse(readFileSync(join(directory, `harness-${target.os}-${target.host}`, 'result.json'), 'utf8'))
    validateRuntimeReport(report, target, expected, hosts)
  }
  return targets.length
}

/** Hosts requested for this run: the declared floor, plus any explicitly requested version. */
function requestedHosts() {
  const extra = (process.env.DSH_TEST_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  return [...new Set([minimumHost(), ...extra])]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  validatePackageCompatibility(pkg)
  if (process.argv.length === 3 && process.argv[2] === '--github-output') {
    const hosts = requestedHosts()
    console.log(`hosts=${JSON.stringify(hosts)}`)
    console.log(`targets=${JSON.stringify(runtimeTargets(hosts))}`)
  } else if (process.argv.length === 6 && process.argv[2] === '--reports' && process.argv[4] === '--sha256') {
    const artifactSha256 = process.argv[5]
    assert.match(artifactSha256, /^[a-f0-9]{64}$/, 'Expected candidate SHA-256 is required')
    const hosts = process.env.EXPECTED_HOSTS ? JSON.parse(process.env.EXPECTED_HOSTS) : requestedHosts()
    const count = validateRuntimeReports(process.argv[3], { pluginVersion: pkg.version, artifactSha256 }, hosts)
    console.log(`Verified one package against ${count} host/platform targets: ${hosts.join(', ')}`)
  } else throw new Error('Usage: node scripts/harness-validation.mjs --github-output | --reports <directory> --sha256 <digest>')
}
