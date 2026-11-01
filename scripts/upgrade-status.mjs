/** Read-only release visibility. Registry discovery never changes the declared floor. */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { compareHostVersions, minimumHost, policy, requiredHostPeers } from './compatibility.mjs'

// The published identity differs per distribution (upstream @nanmicoder, this fork
// @chenxu233); read it instead of hard-coding one scope.
const PACKAGE_NAME = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name
const PACKAGE_REGISTRY_PATH = PACKAGE_NAME.replace('/', '%2F')

const exactVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(0|[1-9]\d*))?$/.test(value) && value.trim() === value

// Understands the current `>=x` engines.dsh and `*` peers, and the exact lists of releases
// up to 0.1.27. Anything else requires review instead of a guessed semver answer.
function parseDeclaration(value) {
  if (typeof value !== 'string') return undefined
  if (value === '*') return () => true
  const lower = /^>=(\S+)$/.exec(value)
  if (lower && exactVersion(lower[1])) return version => compareHostVersions(version, lower[1]) >= 0
  const versions = value.split('||').map(v => v.trim())
  if (!versions.every(exactVersion) || new Set(versions).size !== versions.length) return undefined
  return version => versions.includes(version)
}

/** The lowest host a declaration accepts; null when it accepts every host, undefined when unparseable. */
function declarationFloor(value) {
  if (value === '*') return null
  const lower = /^>=(\S+)$/.exec(typeof value === 'string' ? value : '')
  if (lower && exactVersion(lower[1])) return lower[1]
  const versions = typeof value === 'string' ? value.split('||').map(v => v.trim()) : []
  if (!versions.length || !versions.every(exactVersion)) return undefined
  return [...versions].sort(compareHostVersions)[0]
}

export function inspectUpgradeStatus({ hostTags, pluginManifest }, support = policy) {
  const floor = minimumHost(support)
  if (!hostTags || !exactVersion(hostTags.latest)
      || !exactVersion(hostTags.next)) throw new Error('Registry must return exact latest/next host identities')
  if (pluginManifest?.name !== PACKAGE_NAME || !exactVersion(pluginManifest.version)) throw new Error('Registry plugin identity mismatch')
  const channels = Object.fromEntries(['latest', 'next'].filter(tag => hostTags[tag]).map(tag => [tag, hostTags[tag]]))
  // A host below the floor is genuinely unsupported; anything newer is assumed compatible.
  const belowFloorChannels = Object.entries(channels)
    .filter(([, version]) => compareHostVersions(version, floor) < 0)
    .map(([channel, version]) => ({ channel, version }))
  const fields = Object.hasOwn(pluginManifest.engines ?? {}, 'dsh')
    ? { 'engines.dsh': pluginManifest.engines.dsh }
    : Object.fromEntries([
      ...requiredHostPeers.filter(name => name.startsWith('@deepseek-ai/dsh-')),
      ...Object.keys(pluginManifest.peerDependencies ?? {}).filter(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')),
    ].map(name => [name, pluginManifest.peerDependencies?.[name]]))
  const declarations = Object.entries(fields).map(([name, value]) => ({ name, accepts: parseDeclaration(value), floor: declarationFloor(value) }))
  const unrecognizedDeclarations = declarations.filter(({ accepts }) => !accepts).map(({ name }) => name)
  const accepted = version => declarations.every(({ accepts }) => accepts(version))
  // Users on these host channels cannot install the published plugin at all.
  const blockedChannels = unrecognizedDeclarations.length ? null
    : Object.entries(channels).filter(([, version]) => !accepted(version)).map(([channel, version]) => ({ channel, version }))
  // The published floor can be higher than the source floor; hosts in between are supported here but not installable from npm.
  const publishedFloor = unrecognizedDeclarations.length ? undefined
    : declarations.reduce((highest, { floor: value }) => {
      if (value === null) return highest
      if (value === undefined) return highest
      return highest === undefined || compareHostVersions(value, highest) > 0 ? value : highest
    }, undefined)
  const declarationGap = publishedFloor !== undefined && compareHostVersions(publishedFloor, floor) > 0
    ? { sourceFloor: floor, publishedFloor }
    : null
  return {
    needsAttention: belowFloorChannels.length > 0 || unrecognizedDeclarations.length > 0 || blockedChannels?.length > 0 || declarationGap !== null,
    hostChannels: channels,
    pluginChannel: 'latest', pluginVersion: pluginManifest.version,
    sourceFloor: floor,
    blockedChannels, belowFloorChannels, declarationGap, unrecognizedDeclarations,
    limits: ['Compares declarations only; does not prove runtime compatibility or publish anything.', 'Hosts above the floor are accepted without being listed; only the floor is exercised by CI.', 'Checks host latest/next and plugin latest; other tags and untagged releases require an explicit audit.'],
  }
}

export async function fetchUpgradeStatus(fetcher = fetch, support = policy) {
  async function read(path) {
    const response = await fetcher(`https://registry.npmjs.org/${path}`, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`Registry request failed: ${path}: HTTP ${response.status}`)
    return response.json()
  }
  const [hostTags, pluginManifest] = await Promise.all([
    read('-/package/@deepseek-ai%2Fdsh/dist-tags'),
    read(`${PACKAGE_REGISTRY_PATH}/latest`),
  ])
  return inspectUpgradeStatus({ hostTags, pluginManifest }, support)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/upgrade-status.mjs')
  const result = await fetchUpgradeStatus()
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), ...result }, null, 2))
  process.exitCode = result.needsAttention ? 1 : 0
}
