import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { inspectInstallation } from './doctor.mjs'
import {
  atLeast, declaredHostVersions, peerRangeOf, policy, requiredHostPeers,
  validatePackageCompatibility, validatePolicy, workspacePolicy,
} from './compatibility.mjs'

const readPackage = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('the peer floor admits every later host and rejects older ones', () => {
  const pkg = readPackage()
  const floor = policy.minimumHost
  assert.equal(peerRangeOf(), `>=${floor}`)
  for (const name of Object.keys(pkg.peerDependencies)) {
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
      assert.equal(pkg.peerDependencies[name], peerRangeOf(), `${name} must declare the floor`)
    }
  }
  // The host evaluates peer ranges with includePrerelease, so a floor admits
  // later RCs, later stable releases, and later lines' prereleases.
  for (const version of [floor, '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1', '0.3.0-rc.1', '1.0.0-beta.1']) {
    assert.ok(atLeast(version, floor), `${version} must satisfy the floor`)
  }
  for (const version of ['0.2.1-rc.1', '0.2.0-rc.2', '0.1.7-rc.2', '0.2.0', 'latest', '^0.2.1']) {
    assert.ok(!atLeast(version, floor), `${version} must not satisfy the floor`)
  }
  // Enumerating versions instead of declaring the floor is rejected.
  const enumerated = structuredClone(pkg)
  enumerated.peerDependencies['@deepseek-ai/dsh-agent'] = '0.2.1-rc.4 || 0.2.1-rc.3'
  assert.throws(() => validatePackageCompatibility(enumerated), /compatibility floor/)
  // An unbounded or floating range is not a floor either.
  const floating = structuredClone(pkg)
  floating.peerDependencies['@deepseek-ai/dsh-agent'] = '>=0.2.1-rc.2 <1.0.0'
  assert.throws(() => validatePackageCompatibility(floating), /compatibility floor/)
})

test('policy requires a floor that is itself one of the tested hosts', () => {
  assert.throws(() => validatePolicy({ ...policy, minimumHost: 'latest' }), /minimumHost/)
  assert.throws(() => validatePolicy({ ...policy, minimumHost: '0.2.1-rc.1' }), /minimumHost/)
  assert.throws(() => validatePolicy({
    ...policy,
    minimumHost: '0.2.1-rc.4',
    supportedHosts: policy.supportedHosts.map(host => ({ ...host, track: host.version === '0.2.1-rc.4' ? 'recommended' : 'legacy' })),
  }), /below the minimum/)
})

test('doctor accepts a newer host above the floor and rejects one below it', t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-teams-doctor-floor-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.9' }))
  const above = inspectInstallation(root)
  assert.equal(above.ok, true)
  assert.equal(above.validation.kind, 'above-floor')
  assert.equal(above.minimumHost, policy.minimumHost)
  assert.match(above.limits.join(), /not part of the tested matrix/)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.1' }))
  const below = inspectInstallation(root)
  assert.equal(below.ok, false)
  assert.equal(below.validation.kind, 'unsupported')
  assert.match(below.problems.join(), /requires dsh >= 0\.2\.1-rc\.2/)
})

test('doctor runs through an installed bin symlink and reports success or failure', t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-teams-doctor-bin-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const host = join(root, 'host')
  mkdirSync(host)
  writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: policy.recommendedHost }))
  const bin = join(root, 'dsh-agent-teams-doctor')
  symlinkSync(fileURLToPath(new URL('./doctor.mjs', import.meta.url)), bin, 'file')
  // Unix executes the installed shebang directly. Windows does not implement
  // shebangs: invoke Node with the same symlink path, retaining the argv[1]
  // versus import.meta.url regression without relying on a command shell.
  const windows = process.platform === 'win32'
  const executable = windows ? process.execPath : bin
  const args = [...(windows ? [bin] : []), '--host-root', host, '--json']
  const run = () => spawnSync(executable, args, { encoding: 'utf8', timeout: 5_000 })
  const supported = run()
  assert.equal(supported.error, undefined)
  assert.equal(supported.status, 0, supported.stderr)
  assert.match(supported.stdout, /"checkedPackages"/, 'bin must execute instead of silently importing the script')
  assert.equal(JSON.parse(supported.stdout).ok, true)
  writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.8' }))
  const unsupported = run()
  assert.equal(unsupported.status, 1, unsupported.stderr)
  assert.equal(JSON.parse(unsupported.stdout).ok, false)
})

test('policy rejects floating targets, duplicates, and alpha recommendation', () => {
  assert.deepEqual(validatePolicy(policy), policy.supportedHosts.map(host => host.version))
  for (const version of ['latest', '^0.1.2-rc.1', '0.1.2-rc.1\n']) {
    assert.throws(() => validatePolicy({ ...policy, supportedHosts: [{ version, track: 'recommended' }] }))
  }
  assert.throws(() => validatePolicy({ ...policy, supportedHosts: [...policy.supportedHosts, policy.supportedHosts[0]] }))
  assert.throws(() => validatePackageCompatibility({ devDependencies: { '@deepseek-ai/dsh': '^0.1.2-rc.1' } }))
})

test('doctor detects transitive cohort mixing even with an exact CLI version', t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-teams-doctor-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  function pkg(directory, name, version, dependencies = {}) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version, dependencies }))
  }
  pkg(root, '@deepseek-ai/dsh', '0.2.1-rc.4', { '@deepseek-ai/dsh-agent': '0.2.1-rc.4' })
  const dependency = join(root, 'node_modules/@deepseek-ai/dsh-agent')
  pkg(dependency, '@deepseek-ai/dsh-agent', '0.2.1-rc.3')
  const mixed = inspectInstallation(root)
  assert.equal(mixed.ok, false)
  assert.equal(mixed.checkedPackages, 2)
  assert.match(mixed.problems.join(), /differ from host/)
  pkg(dependency, '@deepseek-ai/dsh-agent', '0.2.1-rc.4')
  assert.equal(inspectInstallation(root).ok, true)
  pkg(root, '@deepseek-ai/dsh', '0.1.0-rc.8')
  assert.match(inspectInstallation(root).problems.join(), /Unsupported host/)
})

test('doctor follows profile peers and rejects duplicate runtime identities', t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-teams-doctor-profile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, data) => {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify(data))
  }
  write(root, { name: '@deepseek-ai/dsh', version: '0.2.1-rc.4', dependencies: { '@deepseek-ai/dsh-agent': '0.2.1-rc.4' } })
  write(join(root, 'node_modules/@deepseek-ai/dsh-agent'), { name: '@deepseek-ai/dsh-agent', version: '0.2.1-rc.4' })
  const profile = join(root, 'profile')
  write(join(profile, 'node_modules/@chenxu233/dsh-agent-teams'), {
    name: '@chenxu233/dsh-agent-teams', version: '0.1.26', peerDependencies: { '@deepseek-ai/dsh-agent': peerRangeOf() },
  })
  write(join(profile, 'node_modules/@deepseek-ai/dsh-agent'), { name: '@deepseek-ai/dsh-agent', version: '0.2.1-rc.4' })
  assert.match(inspectInstallation(root, profile).problems.join(), /Multiple resolved identities/)
})

test('policy rejects missing or mixed development overrides', () => {
  const pkg = readPackage()
  const workspace = structuredClone(workspacePolicy)
  assert.doesNotThrow(() => validatePackageCompatibility(pkg))
  delete workspace.overrides['@deepseek-ai/dsh-agent']
  assert.throws(() => validatePackageCompatibility(pkg, policy, workspace), /override/)
  workspace.overrides['@deepseek-ai/dsh-agent'] = '0.1.2-alpha.2'
  assert.throws(() => validatePackageCompatibility(pkg, policy, workspace), /override/)
  assert.throws(() => validatePackageCompatibility({ ...pkg, pnpm: { overrides: {} } }), /pnpm-workspace/)
})

test('policy rejects removed host peers and range-qualified or conditional DSH overrides', () => {
  const original = readPackage()
  for (const name of requiredHostPeers) {
    const pkg = structuredClone(original)
    delete pkg.peerDependencies[name]
    assert.throws(() => validatePackageCompatibility(pkg), /Missing required host peer/)
  }
  for (const selector of ['parent>@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent@^0.1.2', '@deepseek-ai/dsh@>=0.1>react']) {
    const pkg = structuredClone(original)
    const workspace = structuredClone(workspacePolicy)
    workspace.overrides[selector] = policy.recommendedHost
    assert.throws(() => validatePackageCompatibility(pkg, policy, workspace), /bare DSH package name/)
  }
})

test('doctor reports missing nonoptional Cordis peers and required plugin imports even with optional metadata', t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-teams-doctor-required-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, data) => {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify(data))
  }
  write(root, { name: '@deepseek-ai/dsh', version: policy.recommendedHost, peerDependencies: { '@deepseek-ai/cordis': '^4.0.2' } })
  assert.match(inspectInstallation(root).problems.join(), /Missing packages.*cordis/)
  write(join(root, 'node_modules/@deepseek-ai/cordis'), { name: '@deepseek-ai/cordis', version: '4.0.2' })
  const profile = join(root, 'profile')
  write(join(profile, 'node_modules/@chenxu233/dsh-agent-teams'), {
    name: '@chenxu233/dsh-agent-teams', version: '0.1.26',
    peerDependencies: { '@deepseek-ai/dsh-subagent': peerRangeOf() },
    peerDependenciesMeta: { '@deepseek-ai/dsh-subagent': { optional: true } },
  })
  assert.match(inspectInstallation(root, profile).problems.join(), /dsh-subagent \(plugin runtime\)/)
})

test('doctor detects peer-only drift and a mismatched installed plugin', t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-teams-doctor-peer-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, data) => {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify(data))
  }
  write(root, { name: '@deepseek-ai/dsh', version: '0.2.1-rc.4', dependencies: { '@deepseek-ai/dsh-agent': '0.2.1-rc.4' } })
  write(join(root, 'node_modules/@deepseek-ai/dsh-agent'), {
    name: '@deepseek-ai/dsh-agent', version: '0.2.1-rc.4', peerDependencies: { '@deepseek-ai/dsh-session': '*' },
  })
  write(join(root, 'node_modules/@deepseek-ai/dsh-session'), { name: '@deepseek-ai/dsh-session', version: '0.2.1-rc.3' })
  assert.match(inspectInstallation(root).problems.join(), /differ from host/)
  write(join(root, 'node_modules/@deepseek-ai/dsh-session'), { name: '@deepseek-ai/dsh-session', version: '0.2.1-rc.4' })
  assert.equal(inspectInstallation(root).ok, true)
  const profile = join(root, 'profile')
  write(join(profile, 'node_modules/@chenxu233/dsh-agent-teams'), { name: '@chenxu233/dsh-agent-teams', version: '0.1.15' })
  assert.match(inspectInstallation(root, profile).problems.join(), /0\.1\.15/)
})

test('the recommended host is the newest tested target and enters the download matrix', () => {
  assert.equal(policy.recommendedHost, '0.2.1-rc.4')
  assert.equal(policy.minimumHost, '0.2.1-rc.2')
  assert.ok(validatePolicy(policy).includes('0.2.1-rc.4'))
  assert.ok(validatePolicy(policy).includes('0.2.1-rc.3'))
  assert.ok(validatePolicy(policy).includes('0.2.1-rc.2'))
  assert.deepEqual(declaredHostVersions(), validatePolicy(policy))
  const matrix = spawnSync(process.execPath, [fileURLToPath(new URL('./compatibility.mjs', import.meta.url)), '--github-output'], { encoding: 'utf8' })
  assert.equal(matrix.status, 0, matrix.stderr)
  assert.deepEqual(JSON.parse(matrix.stdout.trim().slice('hosts='.length)), validatePolicy(policy))
})
