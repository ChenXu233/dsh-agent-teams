import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { policy, validatePackageCompatibility } from './compatibility.mjs'

// Keep prereleases away from npm's default channel, including manual publishes.
export function releaseMetadata(pkg, support = policy, workspace) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/.exec(pkg.version)
  if (!match || match[0] !== pkg.version) throw new Error(`Unsupported release version: ${pkg.version}`)
  validatePackageCompatibility(pkg, support, workspace)
  const distTag = match[4] ? support.previewTag : 'latest'
  if (pkg.publishConfig?.tag !== distTag) {
    throw new Error(`publishConfig.tag must be "${distTag}" for ${pkg.version}`)
  }
  // A stable release must not be developed against an alpha/beta host, but it may use any RC at or
  // above the declared floor: the policy deliberately does not pin one "recommended" host.
  if (!match[4] && /-(alpha|beta)\./.test(pkg.devDependencies['@deepseek-ai/dsh'])) {
    throw new Error('latest must not be developed against an alpha/beta host')
  }
  return { value: pkg.version, dist_tag: distTag, prerelease: Boolean(match[4]) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  for (const [key, value] of Object.entries(releaseMetadata(pkg))) {
    console.log(`${key}=${value}`)
  }
}
