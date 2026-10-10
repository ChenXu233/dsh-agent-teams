// Issue #205 regression: the disposition policy for a final member turn failure.
//
// These are pure-function assertions over `classifyMemberFailure`. They are a
// supplement to — not a substitute for — the real-host acceptance, which drives
// a real member Agent through real DeepSeek Flash turns.
//
// The case this file exists to pin: a member with NO open attempt must always be
// recorded, whatever its durable `status` says. `syncMemberStatus` writes
// `working` as soon as a turn runs, while a task completed earlier in that same
// turn leaves no open attempt behind — treating that `working` as "moved on to
// newer work" silently dropped the reporter's run A failure.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyMemberFailure } from '../lib/members.js'

const observed = (task) => ({ captainSessionId: 'captain', memberId: 'member-1', task })
const current = (member, task, observedRecord) => ({ member, task, observedRecord })

test('run A: a working member with no open attempt is recorded', () => {
  // The reporter's run A: the task completed earlier in the turn, so nothing is
  // open, while the member's own record already says it is working. Treating
  // that `working` as "moved on to newer work" silently dropped the failure.
  assert.equal(
    classifyMemberFailure(
      observed({ id: 't1', attempt: 1, attemptId: 'a1' }),
      current({ id: 'member-1', status: 'working' }, undefined, { id: 't1', status: 'completed', subject: 'work' }),
    ),
    'noted_settled',
  )
})

test('a working member with no open attempt and no observed task is recorded too', () => {
  assert.equal(
    classifyMemberFailure(observed(undefined), current({ id: 'member-1', status: 'working' }, undefined, undefined)),
    'noted_settled',
  )
})

test('no open task is recorded when the member is idle or explicitly retired', () => {
  for (const status of ['idle', 'removed']) {
    assert.equal(
      classifyMemberFailure(
        observed({ id: 't1', attempt: 1, attemptId: 'a1' }),
        current({ id: 'member-1', status }, undefined, { id: 't1', status: 'completed', subject: 'work' }),
      ),
      'noted_settled',
      `status ${status}`,
    )
  }
})



test('a replaced member generation stays silent', () => {
  assert.equal(
    classifyMemberFailure(
      observed({ id: 't1', attempt: 1, attemptId: 'a1' }),
      current({ id: 'member-2', status: 'working' }, undefined, undefined),
    ),
    'ignored',
  )
  assert.equal(
    classifyMemberFailure(observed(undefined), current(undefined, undefined, undefined)),
    'ignored',
  )
})

test('a concrete superseded open attempt stays silent', () => {
  // the same task was reassigned to a newer attempt
  assert.equal(
    classifyMemberFailure(
      observed({ id: 't1', attempt: 1, attemptId: 'a1' }),
      current({ id: 'member-1', status: 'working' }, { id: 't1', attempt: 3, attemptId: 'a3' }),
    ),
    'ignored',
  )
  // the member is working on a different task than the one observed
  assert.equal(
    classifyMemberFailure(
      observed({ id: 't1', attempt: 1, attemptId: 'a1' }),
      current({ id: 'member-1', status: 'working' }, { id: 't9', attempt: 1, attemptId: 'a9' }),
    ),
    'ignored',
  )
})

test('the exact observed open attempt is the only mutable case', () => {
  assert.equal(
    classifyMemberFailure(
      observed({ id: 't1', attempt: 2, attemptId: 'a2' }),
      current({ id: 'member-1', status: 'working' }, { id: 't1', attempt: 2, attemptId: 'a2' }),
    ),
    'failed_attempt',
  )
  // an observed attempt with no attemptId must not match a live one
  assert.equal(
    classifyMemberFailure(
      observed({ id: 't1', attempt: 2, attemptId: undefined }),
      current({ id: 'member-1', status: 'working' }, { id: 't1', attempt: 2, attemptId: 'a2' }),
    ),
    'ignored',
  )
})
