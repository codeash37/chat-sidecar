import type { EngineInterface } from 'claude-code'

import type { GitInfo } from '../types'

// The Git section: the branch the current one was made from, whether the folder is a linked worktree, and where the
// main repo is. Read in the session's folder ($.process.run's default), every 60 s and after the main chat's git calls.

/** `rev-parse --abbrev-ref HEAD --path-format=absolute --git-dir --git-common-dir`: the branch and both git dirs. */
export function parseRevParse(out: string | null): { branch: string; gitDir: string; commonDir: string } | null {
  const [branch, gitDir, commonDir] = (out ?? '').split(/\r?\n/).map(line => line.trim())
  return branch && gitDir && commonDir ? { branch, gitDir, commonDir } : null
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** A linked worktree's git dir is not the common one; the main repo is the folder holding the common `.git`. */
export function worktreeOf(gitDir: string, commonDir: string): { isWorktree: boolean; mainRepo?: string } {
  if (norm(gitDir) === norm(commonDir)) return { isWorktree: false }
  const common = commonDir.replace(/\\/g, '/').replace(/\/+$/, '')
  return { isWorktree: true, mainRepo: /\/\.git$/i.test(common) ? common.slice(0, -'/.git'.length) : common }
}

/** The branch's own reflog, newest first: its oldest line says where it was made, `branch: Created from main`. */
export function parseCreatedFrom(out: string | null): string | undefined {
  const lines = (out ?? '').split(/\r?\n/).filter(line => line.trim() !== '')
  const from = /^branch: Created from (.+)$/.exec(lines.at(-1)?.trim() ?? '')?.[1]
  return from?.replace(/^refs\/(heads|remotes)\//, '')
}

/** HEAD's reflog, newest first: the oldest `checkout: moving from <base> to <branch>` names the base. */
export function parseCheckoutBase(out: string | null, branch: string): string | undefined {
  let base: string | undefined
  for (const line of (out ?? '').split(/\r?\n/)) {
    const m = /^checkout: moving from (\S+) to (\S+)$/.exec(line.trim())
    if (m && m[2] === branch) base = m[1]
  }
  return base
}

/**
 * Remote branches that hold a commit (`for-each-ref --contains`), the main ones only: `origin/develop`, not
 * `origin/feat/x`, `origin/HEAD` or the branch's own remote copy.
 */
export function mainRemotes(out: string | null, branch: string): string[] {
  return (out ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(ref => /^[^/]+\/[^/]+$/.test(ref) && !ref.endsWith('/HEAD') && ref.slice(ref.indexOf('/') + 1) !== branch)
}

const isSha = (s: string) => /^[0-9a-f]{7,40}$/i.test(s)

/** Base branches found, by `<common dir>|<branch>`: a branch's base never changes, so it is read once. */
const bases = new Map<string, Pick<GitInfo, 'base' | 'baseCommit'>>()

/**
 * A branch made from a commit (some worktree tools do so) names no branch: its base is the main remote branch holding that commit
 * with the fewest commits past it, the line the work started on; none holds it, the short commit itself.
 */
async function baseOfCommit($: EngineInterface, sha: string, branch: string): Promise<Pick<GitInfo, 'base' | 'baseCommit'>> {
  const short = sha.slice(0, 7)
  let best: { ref: string; ahead: number } | undefined
  for (const ref of mainRemotes(await git($, ['for-each-ref', '--contains', sha, '--format=%(refname:short)', 'refs/remotes']), branch)) {
    const ahead = Number((await git($, ['rev-list', '--count', `${sha}..${ref}`]))?.trim())
    if (Number.isFinite(ahead) && (!best || ahead < best.ahead)) best = { ref, ahead }
  }
  return best ? { base: best.ref, baseCommit: short } : { base: short }
}

async function git($: EngineInterface, args: string[]): Promise<string | null> {
  const r = await $.process.run(['git', ...args], { timeoutMs: 10_000 }).catch(() => null)
  return r && r.exitCode === 0 ? r.stdout : null
}

/**
 * The Git section's facts for the session's folder; null outside a repo, with no commit yet, or without git.
 * `Created from HEAD` (a branch made where HEAD stood: `switch -c`, `checkout -b`) is read from HEAD's checkouts.
 */
export async function readGit($: EngineInterface): Promise<GitInfo | null> {
  const rp = parseRevParse(await git($, ['rev-parse', '--abbrev-ref', 'HEAD', '--path-format=absolute', '--git-dir', '--git-common-dir']))
  if (!rp) return null
  const info: GitInfo = { branch: rp.branch, ...worktreeOf(rp.gitDir, rp.commonDir) }
  // A detached HEAD has no branch to have a base.
  if (rp.branch === 'HEAD') return info
  const key = `${norm(rp.commonDir)}|${rp.branch}`
  if (!bases.has(key)) {
    const created = parseCreatedFrom(await git($, ['reflog', 'show', '--format=%gs', `refs/heads/${rp.branch}`]))
    const named = created && created !== 'HEAD' ? created : parseCheckoutBase(await git($, ['reflog', 'show', '--format=%gs', 'HEAD']), rp.branch)
    bases.set(key, named === undefined ? {} : isSha(named) ? await baseOfCommit($, named, rp.branch) : { base: named })
  }
  return { ...info, ...bases.get(key) }
}
