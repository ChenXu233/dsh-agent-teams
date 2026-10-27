import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const policy = JSON.parse(readFileSync(new URL('../compatibility.json', import.meta.url), 'utf8'))
// JSON is valid YAML and keeps this shipped diagnostic dependency-free.
export const workspacePolicy = JSON.parse(readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8'))

// Contract consumed by the published server entry and client module table.
// Keeping this independent from package.json catches accidentally deleted peers.
export const requiredHostPeers = [
  '@deepseek-ai/cordis', '@deepseek-ai/schemastery', 'react',
  ...[
    'agent', 'api-session-controller', 'client-connection', 'client-locale',
    'client-store', 'client-ui-chat', 'client-ui-conversation', 'client-ui-layout',
    'client-ui-model-selection', 'client-ui-primitives', 'client-ui-renderer',
    'client-ui-session', 'client-ui-slots', 'commands', 'llm', 'session',
    'session-projection', 'subagent', 'system-prompt', 'tools', 'util-values',
  ].map(name => `@deepseek-ai/dsh-${name}`),
]

// These are value imports of the server entry, so optional-peer metadata does
// not make an unresolved installation executable. Client services can instead
// be supplied by the host's browser module table.
export const serverRuntimePeers = [
  '@deepseek-ai/schemastery', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-tools',
]

// Host versions are prereleases of one line; the host itself evaluates peer
// ranges with semver's includePrerelease, so a floor admits every later RC and
// every later stable release.
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/
const PRE_RANK = { alpha: 0, beta: 1, rc: 2 }

function parseVersion(value) {
  if (typeof value !== 'string' || value.trim() !== value) return undefined
  const match = VERSION.exec(value)
  if (!match) return undefined
  return {
    major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]),
    pre: match[4] === undefined ? undefined : { rank: PRE_RANK[match[4]], n: Number(match[5]) },
  }
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  // A release outranks any prerelease of the same numeric tuple.
  if (left.pre === undefined && right.pre === undefined) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  if (left.pre.rank !== right.pre.rank) return left.pre.rank < right.pre.rank ? -1 : 1
  if (left.pre.n !== right.pre.n) return left.pre.n < right.pre.n ? -1 : 1
  return 0
}

/**
 * Whether one host version is at or above a floor version.
 * @param version - candidate host version.
 * @param floor - minimum compatible host version.
 */
export function atLeast(version, floor) {
  const candidate = parseVersion(version)
  const minimum = parseVersion(floor)
  if (candidate === undefined || minimum === undefined) return false
  return compareVersions(candidate, minimum) >= 0
}

/** The peer range every DSH package must declare: one floor, no enumeration. */
export function peerRangeOf(input = policy) {
  return `>=${input.minimumHost}`
}

/**
 * Validate the compatibility policy itself.
 * @param input - parsed compatibility.json.
 * @returns the tested host matrix (CI download targets).
 */
export function validatePolicy(input) {
  if (input.schemaVersion !== 1 || input.previewTag !== 'next') throw new Error('Unsupported compatibility policy')
  if (parseVersion(input.minimumHost) === undefined) throw new Error('minimumHost must be one exact semantic version')
  const hosts = input.supportedHosts
  if (!Array.isArray(hosts) || hosts.length === 0) throw new Error('supportedHosts must list exact tested host targets')
  const versions = new Set()
  for (const host of hosts) {
    if (parseVersion(host.version) === undefined || versions.has(host.version)
        || !['recommended', 'preview', 'legacy'].includes(host.track)) {
      throw new Error('Host targets must be unique exact versions with an explicit track')
    }
    versions.add(host.version)
  }
  const recommended = hosts.filter(host => host.track === 'recommended')
  if (recommended.length !== 1 || recommended[0].version !== input.recommendedHost) throw new Error('Exactly one recommended host is required')
  if (/-(alpha|beta)\./.test(input.recommendedHost)) throw new Error('Alpha/beta hosts cannot be the ordinary-user recommendation')
  if (!versions.has(input.minimumHost)) throw new Error('minimumHost must be one of the tested host targets')
  for (const version of versions) {
    if (!atLeast(version, input.minimumHost)) throw new Error(`Tested host ${version} is below the minimum compatible host ${input.minimumHost}`)
  }
  return hosts.map(host => host.version)
}

/** Every host version this build claims to run on: the tested matrix. */
export function declaredHostVersions(input = policy) {
  return validatePolicy(input)
}

/**
 * Validate package.json against the policy.
 * @param pkg - parsed package.json.
 * @param input - compatibility policy.
 * @param workspace - parsed pnpm-workspace.yaml.
 * @returns the tested host matrix.
 */
export function validatePackageCompatibility(pkg, input = policy, workspace = workspacePolicy) {
  const versions = validatePolicy(input)
  for (const name of requiredHostPeers) {
    if (typeof pkg.peerDependencies?.[name] !== 'string' || pkg.peerDependencies[name].trim() === '') {
      throw new Error(`Missing required host peer declaration: ${name}`)
    }
  }
  const baseline = pkg.devDependencies?.['@deepseek-ai/dsh']
  if (!versions.includes(baseline)) throw new Error('Development host must be an exact supported target')
  for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
      if (version !== baseline) throw new Error(`${name} must match the exact development host ${baseline}`)
    }
  }
  if (pkg.pnpm?.overrides) throw new Error('Move pnpm.overrides to pnpm-workspace.yaml for pnpm 11')
  const overrides = workspace.overrides ?? {}
  const dshNames = Object.keys(pkg.devDependencies ?? {}).filter(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  for (const name of dshNames) {
    if (overrides[name] !== baseline) throw new Error(`${name} requires an exact pnpm override to ${baseline}`)
  }
  for (const [name, version] of Object.entries(overrides)) {
    if (name.includes('@deepseek-ai/dsh')) {
      if (!/^@deepseek-ai\/dsh(?:-[a-z0-9-]+)?$/.test(name)) {
        throw new Error(`${name} override must use a bare DSH package name, without ranges or parent selectors`)
      }
      if (version !== baseline) throw new Error(`${name} override must match the development host ${baseline}`)
    }
  }
  const floor = peerRangeOf(input)
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
      if (range.trim() !== floor) throw new Error(`${name} peer range must be the compatibility floor ${floor}`)
    }
  }
  return versions
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const hosts = validatePackageCompatibility(pkg)
  if (process.argv[2] === '--github-output') console.log(`hosts=${JSON.stringify(hosts)}`)
  else if (process.argv.length === 2) console.log(`Compatibility floor: ${peerRangeOf()}; tested: ${hosts.join(', ')}`)
  else throw new Error('Usage: node scripts/compatibility.mjs [--github-output]')
}
