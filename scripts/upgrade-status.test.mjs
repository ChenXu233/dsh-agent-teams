import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { inspectUpgradeStatus, fetchUpgradeStatus } from './upgrade-status.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const fixture = () => ({ hostTags: { latest: '0.2.2-rc.3', next: '0.2.2-rc.3' }, pluginManifest: structuredClone(pkg) })

test('a published floor at the source floor has no declaration gap', () => {
  const result = inspectUpgradeStatus(fixture())
  assert.equal(result.needsAttention, false)
  assert.equal(result.declarationGap, null)
  assert.deepEqual(result.belowFloorChannels, [])
})

test('a host released after the plugin is accepted without a policy edit', () => {
  const input = fixture()
  input.hostTags = { latest: '0.2.3', next: '0.2.3' }
  const result = inspectUpgradeStatus(input)
  assert.equal(result.needsAttention, false, 'the floor is open-ended; newer hosts need no declaration change')
  assert.deepEqual(result.blockedChannels, [])
  assert.deepEqual(result.belowFloorChannels, [])
})

test('a channel older than the floor is reported as blocking users', () => {
  const input = fixture()
  input.hostTags = { latest: '0.2.0', next: '0.2.0' }
  const result = inspectUpgradeStatus(input)
  assert.equal(result.needsAttention, true)
  assert.deepEqual(result.belowFloorChannels, [{ channel: 'latest', version: '0.2.0' }, { channel: 'next', version: '0.2.0' }])
  assert.deepEqual(result.blockedChannels, [{ channel: 'latest', version: '0.2.0' }, { channel: 'next', version: '0.2.0' }])
})

test('a published floor above the source floor hides hosts users could otherwise use', () => {
  const input = fixture()
  input.hostTags = { latest: '0.2.3', next: '0.2.3' }
  input.pluginManifest.engines.dsh = '>=0.2.3'
  const result = inspectUpgradeStatus(input)
  assert.equal(result.needsAttention, true)
  assert.deepEqual(result.blockedChannels, [])
  assert.deepEqual(result.declarationGap, { sourceFloor: '0.2.2-rc.3', publishedFloor: '0.2.3' })
})

test('engines precedence, missing declarations and unfamiliar ranges cannot report a false all-clear', () => {
  for (const dsh of [null, '^0.2.2-rc.3', '>=0.2.1-rc.2 <0.3.0']) {
    const input = fixture()
    input.pluginManifest.engines.dsh = dsh
    const result = inspectUpgradeStatus(input)
    assert.equal(result.needsAttention, true)
    assert.deepEqual(result.unrecognizedDeclarations, ['engines.dsh'])
    assert.equal(result.declarationGap, null)
  }
  // An exact engines.dsh only accepts that one host, so a newer channel is blocked.
  const exact = fixture()
  exact.hostTags = { latest: '0.2.3', next: '0.2.3' }
  exact.pluginManifest.engines.dsh = '0.2.2-rc.3'
  assert.equal(inspectUpgradeStatus(exact).needsAttention, true)
  // Without engines.dsh (hosts before 0.2.1-alpha.4 and older manifests) every DSH peer must be readable.
  const input = fixture()
  delete input.pluginManifest.engines.dsh
  assert.equal(inspectUpgradeStatus(input).needsAttention, false, '* peers accept every host')
  delete input.pluginManifest.peerDependencies['@deepseek-ai/dsh-agent']
  assert.deepEqual(inspectUpgradeStatus(input).unrecognizedDeclarations, ['@deepseek-ai/dsh-agent'])
})

test('registry errors, invalid JSON and wrong identities fail instead of becoming a green empty status', async () => {
  for (const input of [ { ...fixture(), hostTags: {} }, { ...fixture(), hostTags: { latest: '0.2.2-rc.3' } }, { ...fixture(), hostTags: { next: '0.2.2-rc.3' } }, { ...fixture(), pluginManifest: { name: 'other', version: pkg.version } } ]) {
    assert.throws(() => inspectUpgradeStatus(input))
  }
  await assert.rejects(fetchUpgradeStatus(async () => ({ ok: false, status: 503 })), /HTTP 503/)
  await assert.rejects(fetchUpgradeStatus(async () => ({ ok: true, json: async () => { throw new Error('Invalid JSON') } })), /Invalid JSON/)
  const requests = []
  const result = await fetchUpgradeStatus(async url => {
    requests.push(url)
    return { ok: true, json: async () => url.endsWith('dist-tags') ? fixture().hostTags : fixture().pluginManifest }
  })
  assert.equal(result.needsAttention, false)
  assert.equal(requests.length, 2)
  assert.ok(requests.every(url => url.startsWith('https://registry.npmjs.org/')))
})