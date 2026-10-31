import { expect, test } from 'claude-code/testing'

import { mainRemotes, parseCheckoutBase, parseCreatedFrom, parseRevParse, worktreeOf } from './git'

test('rev-parse: the branch and both git dirs; anything short of three lines is no repo', () => {
  expect(parseRevParse('feature/x\nC:/dev/acme/.git\nC:/dev/acme/.git\n')).toEqual({ branch: 'feature/x', gitDir: 'C:/dev/acme/.git', commonDir: 'C:/dev/acme/.git' })
  expect(parseRevParse('main\r\nC:/a/.git\r\nC:/a/.git\r\n')?.branch).toBe('main')
  expect(parseRevParse('')).toBeNull()
  expect(parseRevParse(null)).toBeNull()
})

test('a linked worktree: its git dir is not the common one; the main repo holds the common .git', () => {
  expect(worktreeOf('C:/dev/acme/.git', 'C:/dev/acme/.git')).toEqual({ isWorktree: false })
  expect(worktreeOf('C:/dev/acme/.git/worktrees/wt1', 'C:/dev/acme/.git')).toEqual({ isWorktree: true, mainRepo: 'C:/dev/acme' })
  // Case and slashes don't make a worktree.
  expect(worktreeOf('c:\\dev\\acme\\.git', 'C:/dev/acme/.git/')).toEqual({ isWorktree: false })
  // A bare common dir is the main repo itself.
  expect(worktreeOf('C:/srv/repo.git/worktrees/a', 'C:/srv/repo.git')).toEqual({ isWorktree: true, mainRepo: 'C:/srv/repo.git' })
})

test("a branch's reflog: its oldest line names where it was made", () => {
  expect(parseCreatedFrom('commit: fix\ncommit: start\nbranch: Created from main\n')).toBe('main')
  expect(parseCreatedFrom('branch: Created from origin/main')).toBe('origin/main')
  expect(parseCreatedFrom('branch: Created from refs/heads/develop')).toBe('develop')
  expect(parseCreatedFrom('branch: Created from refs/remotes/origin/develop')).toBe('origin/develop')
  // switch -c / checkout -b / worktree add without -b: made where HEAD stood.
  expect(parseCreatedFrom('branch: Created from HEAD')).toBe('HEAD')
  expect(parseCreatedFrom('commit (initial): first')).toBeUndefined()
  expect(parseCreatedFrom(null)).toBeUndefined()
})

test("HEAD's reflog: the oldest checkout onto the branch names its base", () => {
  const head = [
    'checkout: moving from feat1 to main',
    'commit: more',
    'checkout: moving from develop to feat1',
    'checkout: moving from main to feat1',
    'commit: on main',
  ].join('\n')
  expect(parseCheckoutBase(head, 'feat1')).toBe('main')
  expect(parseCheckoutBase(head, 'other')).toBeUndefined()
  // worktree add without -b: only a reset, no checkout.
  expect(parseCheckoutBase('reset: moving to HEAD', 'wt2')).toBeUndefined()
})

test('the main remote branches holding a commit: not feature branches, HEAD or the branch itself', () => {
  const out = 'origin/HEAD\norigin/develop\norigin/dev-next\norigin/feat/login\norigin/chore/renovate-maven-(minor)\norigin/wt-docs\nupstream/main\n'
  expect(mainRemotes(out, 'wt-docs')).toEqual(['origin/develop', 'origin/dev-next', 'upstream/main'])
  expect(mainRemotes(null, 'x')).toEqual([])
})
