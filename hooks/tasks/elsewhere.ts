// chat-sidecar's own (not from human-in-the-loop): open tasks of other folders, such as other worktrees, for the
// Elsewhere part of the sidecar's Tasks for me. Read only: a task is answered in its own folder's session.
import type { EngineInterface } from 'claude-code'

import type { Task } from '../../types'

export type ElsewhereTask = { folder: string; task: Task }

/** The last part of a path. */
const base = (p: string) => p.slice(p.replace(/\/+$/, '').lastIndexOf('/') + 1)

/** Open tasks under every other folder's store keys (`all`, or the store's), deduplicated across that folder's session slots; a folder gone from disk has its keys deleted. */
export async function tasksElsewhere($: EngineInterface, all?: readonly string[]): Promise<ElsewhereTask[]> {
  const own = (await $.session.root()).replace(/\\/g, '/').toLowerCase()
  const keys = (all ?? (await $.store.keys())).filter(key => key.startsWith('tasks:'))
  const seen = new Set<string>()
  const out: ElsewhereTask[] = []
  const gone = new Map<string, Promise<boolean>>()
  for (const key of keys) {
    // `tasks:<root>#session:<id>`, or 0.1.4's `tasks:<root>`; a root too long for a key goes by `#<hash>`.
    const root = key.slice('tasks:'.length).split('#session:')[0]!.replace(/\\/g, '/')
    if (root.toLowerCase() === own) continue
    // A deleted folder (a removed worktree) has no session to answer its tasks: its keys leave the store.
    // A hashed root can't be checked; a failed check keeps the key.
    if (!gone.has(root)) gone.set(root, root.startsWith('#') ? Promise.resolve(false) : $.fs.exists(root).then(is => !is, () => false))
    if (await gone.get(root)) {
      await $.store.delete(key).catch(() => undefined)
      continue
    }
    const value = (await $.store.get(key).catch(() => undefined)) as { tasks?: unknown } | undefined
    const tasks = Array.isArray(value?.tasks) ? (value.tasks as Task[]) : []
    for (const task of tasks) {
      // Limit: a hashed root (path over the key limit) shows as "(long path)" and is never skipped as own.
      const folder = root.startsWith('#') ? '(long path)' : base(root.replace(/\/+$/, ''))
      const id = `${root}|${task.sessionId}|${task.id}|${task.title}`
      if (task.state !== 'open' || seen.has(id)) continue
      seen.add(id)
      out.push({ folder, task })
    }
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder) || a.task.createdMs - b.task.createdMs)
}
