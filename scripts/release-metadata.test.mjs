import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { releaseMetadata } from './release-metadata.mjs'
import { policy, workspacePolicy } from './compatibility.mjs'

const fixture = (version, tag) => ({
  ...JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
  version, publishConfig: { tag },
})

test('stable latest requires the recommended host and bounded compatibility', () => {
  assert.deepEqual(releaseMetadata(fixture('0.1.16', 'latest')), {
    value: '0.1.16', dist_tag: 'latest', prerelease: false,
  })
  // A stable release must use the RECOMMENDED host as its baseline; an older
  // tested target is accepted by the compatibility gate but not by the channel.
  const olderHost = fixture('0.1.16', 'latest')
  for (const name of Object.keys(olderHost.devDependencies)) {
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) olderHost.devDependencies[name] = '0.2.1-rc.3'
  }
  const workspace = structuredClone(workspacePolicy)
  for (const name of Object.keys(workspace.overrides)) {
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) workspace.overrides[name] = '0.2.1-rc.3'
  }
  assert.throws(() => releaseMetadata(olderHost, policy, workspace), /recommended host/)
  assert.throws(() => releaseMetadata(fixture('0.1.16', 'latest'), {
    ...policy, minimumHost: '0.2.1-alpha.1', recommendedHost: '0.2.1-alpha.1',
    supportedHosts: [{ version: '0.2.1-alpha.1', track: 'recommended' }],
  }), /Alpha\/beta/)
})

for (const suffix of ['alpha', 'beta', 'rc']) {
  test(`${suffix} candidates use next and never replace latest`, () => {
    const version = `0.1.16-${suffix}.1`
    assert.equal(releaseMetadata(fixture(version, 'next')).prerelease, true)
    for (const tag of [undefined, 'latest', suffix]) {
      assert.throws(() => releaseMetadata(fixture(version, tag)), /publishConfig.tag/)
    }
  })
}

test('reject unsupported versions and unbounded peers', () => {
  for (const version of ['0.1.16-dev.1', '0.1.16-alpha.01', '0.1.16-alpha.1\n', 'v0.1.16', '0.1']) {
    assert.throws(() => releaseMetadata(fixture(version, 'next')))
  }
  const mixed = fixture('0.1.16-rc.1', 'next')
  mixed.peerDependencies['@deepseek-ai/dsh-agent'] = '^0.1.2-alpha.2'
  assert.throws(() => releaseMetadata(mixed), /compatibility floor/)
})

test('checked-in candidate has consistent dependency and release metadata', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(releaseMetadata(pkg).dist_tag, pkg.publishConfig.tag)
})
