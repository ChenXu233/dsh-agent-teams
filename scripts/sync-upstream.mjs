#!/usr/bin/env node
/**
 * Reproducible upstream-sync flow (docs/upstream-sync.md).
 *
 * Layers, in order:
 *   1. lib/**            -> merge=built-artifacts   (take upstream, rebuild later)
 *   2. pnpm-lock.yaml    -> merge=lockfile-upstream (take upstream, re-resolve)
 *   3. rerere            -> enabled + autoupdate    (repeat conflicts replay)
 *   4. semantic src/**   -> NEVER auto-resolved. The script stops with a hunk-level
 *      report (file + conflict block) and leaves the merge uncommitted so a
 *      human can judge every block. It never commits a tree that still
 *      contains conflict markers.
 *
 * Safety contract (what this script will never do):
 *   - never `git push`
 *   - never `git reset --hard`
 *   - never delete branches (including backup/*)
 *   - never commit an unresolved merge or a tree containing conflict markers
 *
 * Usage:
 *   node scripts/sync-upstream.mjs             # sync the current branch
 *   node scripts/sync-upstream.mjs --dry-run   # rehearse in a throwaway worktree
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Run one git command; returns { status, stdout, stderr }. Throws on failure unless allowFailure. */
function git(args, opts = {}) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`)
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Idempotent git config write; prints the effective value each time. */
function ensureConfig(key, value) {
  git(['config', key, value])
  const current = git(['config', '--get', key]).stdout.trim()
  console.log(`[config] ${key} = ${current}`)
  return current
}

const DRIVER_COMMANDS = {
  'merge.built-artifacts.driver': 'cp %B %A',
  'merge.lockfile-upstream.driver': 'cp %B %A',
}

/**
 * Install every mechanical layer. Safe to run any number of times: each step
 * either confirms an existing value or writes it once.
 */
function installMechanicalLayers() {
  const attributesPath = join(REPO_ROOT, '.gitattributes')
  let attributes = existsSync(attributesPath) ? readFileSync(attributesPath, 'utf8') : ''
  const needed = [
    { line: 'lib/** merge=built-artifacts', driver: 'merge.built-artifacts.driver' },
    { line: 'pnpm-lock.yaml merge=lockfile-upstream', driver: 'merge.lockfile-upstream.driver' },
  ]
  let changed = false
  const lines = attributes.split(/\r?\n/)
  for (const { line, driver } of needed) {
    if (!lines.some((existing) => existing.trim() === line)) {
      lines.push(line)
      changed = true
      console.log(`[gitattributes] added: ${line}`)
    } else {
      console.log(`[gitattributes] already present: ${line}`)
    }
    ensureConfig(driver, DRIVER_COMMANDS[driver])
  }
  if (changed) {
    const next = lines.filter((line, index) => line.trim() !== '' || index === lines.length - 1).join('\n')
    writeFileSync(attributesPath, next.endsWith('\n') ? next : next + '\n')
    console.log('[gitattributes] saved .gitattributes (commit it so clones inherit the drivers)')
  }
  ensureConfig('rerere.enabled', 'true')
  ensureConfig('rerere.autoupdate', 'true')
  console.log('[rerere] replay applies from the NEXT merge onward: conflicts resolved before rerere was enabled are not remembered.')
}

/** Collect every path still in the unmerged state. */
function unmergedPaths() {
  return git(['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

/** Extract every conflict hunk of a file, for the human-judgment report. */
function conflictHunks(file, root = REPO_ROOT) {
  const raw = readFileSync(join(root, file), 'utf8')
  const lines = raw.split(/\r?\n/)
  const hunks = []
  let start
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('<<<<<<<')) start = index + 1
    else if (start !== undefined && line.startsWith('>>>>>>>')) {
      hunks.push({ startLine: start, endLine: index + 1 })
      start = undefined
    }
  }
  return hunks
}

/** The hunk-level human report; the deliverable when semantic conflicts remain. */
function printSemanticReport(paths, root = REPO_ROOT) {
  console.log('')
  console.log('=== SEMANTIC CONFLICTS - human judgment required ===')
  console.log('The merge is left UNCOMMITTED. For each hunk decide: keep ours, keep theirs, or merge both.')
  console.log('')
  for (const file of paths) {
    const hunks = conflictHunks(file, root)
    console.log(`-- ${file} (${hunks.length} hunk(s)) --`)
    for (const hunk of hunks) console.log(`   lines ${hunk.startLine}-${hunk.endLine}`)
  }
  console.log('')
  console.log('After resolving every block: git add <files> && git commit, then pnpm install, pnpm build, pnpm typecheck and the test suites.')
  console.log('This script will not commit for you - an unresolved merge is never auto-committed.')
}

/** One throwaway worktree rehearsal; the main tree is never touched. */
function dryRun() {
  git(['fetch', 'upstream'])
  const upstreamTip = git(['rev-parse', 'upstream/main']).stdout.trim()
  console.log(`[dry-run] upstream/main = ${upstreamTip}`)
  const worktree = mkdtempSync(join(tmpdir(), 'dsh-sync-rehearsal-'))
  const head = git(['rev-parse', 'HEAD']).stdout.trim()
  try {
    git(['worktree', 'add', '--detach', worktree, head])
    console.log(`[dry-run] rehearsing merge of upstream/main into detached ${head.slice(0, 9)} at ${worktree}`)
    spawnSync('git', ['merge', 'upstream/main', '--no-commit', '--no-ff'], { cwd: worktree, encoding: 'utf8' })
    const probe = spawnSync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: worktree, encoding: 'utf8' })
    const paths = (probe.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
    if (paths.length === 0) {
      console.log('[dry-run] no conflicts: the merge would complete cleanly.')
    } else {
      console.log(`[dry-run] ${paths.length} conflicted file(s):`)
      for (const file of paths) {
        const hunks = conflictHunks(file, worktree)
        console.log(`  - ${file} (${hunks.length} hunk(s))`)
        for (const hunk of hunks) console.log(`      lines ${hunk.startLine}-${hunk.endLine}`)
      }
      console.log('[dry-run] resolve these hunks by hand in the real tree (boundary table: docs/upstream-sync.md).')
    }
  } finally {
    git(['worktree', 'remove', '--force', worktree])
    console.log('[dry-run] rehearsal worktree removed; main working tree untouched.')
  }
}

async function main() {
  const dryRunOnly = process.argv.includes('--dry-run')
  console.log('=== upstream sync (docs/upstream-sync.md) ===')
  console.log('Safety: this script never pushes, never runs `git reset --hard`, never deletes branches,')
  console.log('and never commits an unresolved merge.')
  installMechanicalLayers()
  if (dryRunOnly) {
    dryRun()
    return
  }
  git(['fetch', 'upstream'])
  const branch = git(['branch', '--show-current']).stdout.trim()
  if (branch === '' || branch === 'main') {
    throw new Error('refusing to sync from main; check out the working branch that should receive upstream')
  }
  console.log(`[merge] merging upstream/main into ${branch}`)
  const merge = spawnSync('git', ['merge', 'upstream/main', '--no-commit', '--no-ff'], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (merge.status === 0) {
    console.log('[merge] clean merge (no conflicts). Finish with `git commit`, then `pnpm install`, `pnpm build`, `pnpm typecheck` and the test suites.')
    return
  }
  const unmerged = unmergedPaths()
  const mechanical = unmerged.filter((file) => file.startsWith('lib/') || file === 'pnpm-lock.yaml')
  const semantic = unmerged.filter((file) => !mechanical.includes(file))
  if (mechanical.length > 0) {
    // Drivers normally resolve these during the merge; anything left is staged
    // from the correct side explicitly so the merge can be finished by hand.
    for (const file of mechanical) {
      git(['checkout', file.startsWith('lib/') ? '--ours' : '--theirs', file])
      git(['add', file])
      console.log(`[mechanical] ${file} staged from ${file.startsWith('lib/') ? 'ours (rebuild after merge)' : 'theirs (upstream lockfile)'}`)
    }
  }
  if (semantic.length > 0) {
    console.log(`[semantic] ${semantic.length} file(s) need human judgment - stopping without committing.`)
    printSemanticReport(semantic)
    process.exitCode = 1
    return
  }
  console.log('[done] all conflicts were mechanical and are staged. Verify, then commit the merge yourself:')
  console.log('       pnpm install && pnpm build && pnpm typecheck && node --test scripts/member-context-budget.test.mjs')
}

main().catch((error) => {
  console.error(String(error?.message ?? error))
  process.exitCode = 1
})
