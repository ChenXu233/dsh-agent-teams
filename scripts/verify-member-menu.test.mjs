/**
 * Verification for the `/` menu helpers (plan 10).
 * Imports the BUILT client bundle. Run `pnpm build` first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { MENU_LIMIT, filterCommands, menuQuery, moveSelection } from '../lib/client/member-menu.js'

const COMMANDS = [
  { name: 'compact', description: 'Compact history' },
  { name: 'context', description: 'Context report' },
  { name: 'plan' },
  { name: 'review' },
]

test('menuQuery only opens for a bare /name fragment', () => {
  assert.equal(menuQuery('/'), '')
  assert.equal(menuQuery('/com'), 'com')
  assert.equal(menuQuery('/COMPACT'), 'compact')
  assert.equal(menuQuery('/compact now'), undefined)
  assert.equal(menuQuery('hello'), undefined)
  assert.equal(menuQuery('/compact\nmore'), undefined)
})

test('filterCommands matches by prefix and caps the row count', () => {
  assert.deepEqual(filterCommands(COMMANDS, 'co').map((c) => c.name), ['compact', 'context'])
  assert.deepEqual(filterCommands(COMMANDS, '').map((c) => c.name), ['compact', 'context', 'plan', 'review'])
  assert.deepEqual(filterCommands(COMMANDS, 'zzz'), [])
  assert.equal(filterCommands(COMMANDS, undefined).length, 0)
  const many = Array.from({ length: 20 }, (_, index) => ({ name: `cmd${index}` }))
  assert.equal(filterCommands(many, 'cmd').length, MENU_LIMIT)
})

test('moveSelection wraps and starts at either end', () => {
  assert.equal(moveSelection(-1, 1, 3), 0)
  assert.equal(moveSelection(-1, -1, 3), 2)
  assert.equal(moveSelection(2, 1, 3), 0)
  assert.equal(moveSelection(0, -1, 3), 2)
  assert.equal(moveSelection(0, 1, 0), -1)
})
