import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  archiveTeamDir,
  ArchivedDeleteRefused,
  createTeamDir,
  listArchivedTeamIds,
  readArchivedTeam,
  readTeam,
  removeArchivedTeamDir,
} from '../lib/state.js'

/** Minimal durable team record; the parser accepts an empty roster and task list. */
const team = (id) => ({
  name: id,
  id,
  captainSessionId: `sess-${id}`,
  createdAt: 1,
  members: [],
  tasks: [],
  taskSeq: 0,
})

const freshRoot = () => mkdtemp(join(tmpdir(), 'dsh-agent-teams-archive-delete-'))

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const refusal = (code) => (error) => error instanceof ArchivedDeleteRefused && error.code === code

test('deletes the requested archive and leaves every other tree in place', async () => {
  const stateRoot = await freshRoot()
  try {
    for (const id of ['keep-me', 'drop-me']) {
      await createTeamDir(stateRoot, team(id))
      await archiveTeamDir(stateRoot, id)
    }
    await createTeamDir(stateRoot, team('live-team'))

    await removeArchivedTeamDir(stateRoot, 'drop-me')

    assert.deepEqual(await listArchivedTeamIds(stateRoot), ['keep-me'])
    assert.equal(await exists(join(stateRoot, 'archive', 'drop-me')), false)
    assert.equal((await readArchivedTeam(stateRoot, 'keep-me'))?.id, 'keep-me')
    assert.equal((await readTeam(stateRoot, 'live-team'))?.id, 'live-team')
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('refuses ids that are not a plain directory name', async () => {
  const stateRoot = await freshRoot()
  try {
    const ids = ['', '.', '..', '../escape', 'a/b', 'a\\b', '.previous-generation']
    for (const id of ids) {
      await assert.rejects(removeArchivedTeamDir(stateRoot, id), refusal('invalid-team-id'))
    }
    assert.deepEqual(await listArchivedTeamIds(stateRoot), [])
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('refuses when the id was never archived', async () => {
  const stateRoot = await freshRoot()
  try {
    await createTeamDir(stateRoot, team('only-live'))
    await assert.rejects(removeArchivedTeamDir(stateRoot, 'only-live'), refusal('not-archived'))
    await assert.rejects(removeArchivedTeamDir(stateRoot, 'never-existed'), refusal('not-archived'))
    assert.equal((await readTeam(stateRoot, 'only-live'))?.id, 'only-live')
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('a live team holding the same id blocks the delete and nothing is touched', async () => {
  const stateRoot = await freshRoot()
  try {
    await createTeamDir(stateRoot, team('busy'))
    await archiveTeamDir(stateRoot, 'busy')
    const archivedBefore = JSON.stringify(await readArchivedTeam(stateRoot, 'busy'))

    // Re-using the id for a live team is the runner's own re-run path.
    await createTeamDir(stateRoot, team('busy'))

    await assert.rejects(removeArchivedTeamDir(stateRoot, 'busy'), refusal('still-active'))

    assert.deepEqual(await listArchivedTeamIds(stateRoot), ['busy'])
    assert.equal(JSON.stringify(await readArchivedTeam(stateRoot, 'busy')), archivedBefore)
    assert.equal((await readTeam(stateRoot, 'busy'))?.id, 'busy')
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})
