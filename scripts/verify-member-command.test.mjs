/**
 * Verification for the single member command path (plan 10).
 *
 * Imports the BUILT bundle (../lib/**.js) - run `pnpm build` first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MemberCommandError,
  assertMemberCommandLine,
  executeMemberCommand,
  isDeniedMemberCommand,
} from '../lib/member-command.js'

const AGENT = { id: 'child-1', session: { header: { cwd: '/tmp' } } }

function port(outcome) {
  const calls = []
  return {
    calls,
    async execute(agent, line, attachments, signal) {
      calls.push({ agent, line, attachments, signal })
      return outcome
    },
  }
}

test('deny matches the canonical name and its whole alias family', () => {
  assert.equal(isDeniedMemberCommand('agent-teams', ['agent-teams']), true)
  assert.equal(isDeniedMemberCommand('agent-teams-plan', ['agent-teams']), true)
  assert.equal(isDeniedMemberCommand('compact', ['agent-teams']), false)
})

test('the deny check follows the host grammar: a case mismatch is unclaimed, not denied', () => {
  assert.equal(assertMemberCommandLine('/AGENT-TEAMS', ['agent-teams']), undefined)
  assert.equal(assertMemberCommandLine('/Compact', []), undefined)
  assert.throws(
    () => assertMemberCommandLine('/agent-teams', ['agent-teams']),
    (error) => error instanceof MemberCommandError && error.code === 'command/denied',
  )
})

test('assertMemberCommandLine leaves the host grammar alone and only caps length', () => {
  for (const line of ['', 'hello', '/', '/COMPACT', '/ compact']) {
    assert.equal(assertMemberCommandLine(line, []), undefined)
  }
  assert.throws(() => assertMemberCommandLine('/' + 'a'.repeat(512), []), MemberCommandError)
})

test('executeMemberCommand returns the normalized success outcome', async () => {
  const commands = port({ commandId: 'cmd-1', result: { kind: 'success', text: 'done' } })
  const result = await executeMemberCommand({
    commands, agent: AGENT, line: '/compact', signal: new AbortController().signal,
  })
  assert.deepEqual(result, { ok: true, kind: 'success', text: 'done', commandId: 'cmd-1' })
  assert.equal(commands.calls[0].line, '/compact')
  assert.deepEqual(commands.calls[0].attachments, [])
})

test('executeMemberCommand reports an unclaimed line as an ok:false result', async () => {
  const commands = port(undefined)
  const result = await executeMemberCommand({
    commands, agent: AGENT, line: '/nope', signal: new AbortController().signal, subject: 'writer',
  })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /no registered command handled "\/nope" in member "writer"/)
})

test('executeMemberCommand keeps a command-reported error as an outcome', async () => {
  const commands = port({ commandId: 'cmd-2', result: { kind: 'error', text: 'busy' } })
  const result = await executeMemberCommand({
    commands, agent: AGENT, line: '/compact', signal: new AbortController().signal,
  })
  assert.deepEqual(result, { ok: false, kind: 'error', text: 'busy', commandId: 'cmd-2' })
})
