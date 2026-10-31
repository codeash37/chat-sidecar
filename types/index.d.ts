// ---- Own types: Git, Background, the subagent phase used by bar styles, and the task system. Kept by the clean-room rewrite. ----

export type HelperPhase = 'working' | 'done' | 'failed'

/** The Git section: the current branch, the one it was made from (when the reflog says), and the worktree's main repo. */
export type GitInfo = {
  branch: string
  base?: string
  /** The commit the branch was made from, short, when `base` was worked out from it (a branch made from a commit). */
  baseCommit?: string
  isWorktree: boolean
  mainRepo?: string
}

export type Listener = {
  /** `port:<port>:<pid>` for a listening server, `proc:<label>` for a group of matching processes. */
  key: string
  label: string
  port?: number
  /** The first pid of the group. */
  pid: number
  /** Every pid of the group: a run whose pids share none with the previous scan is a new run. */
  pids: number[]
  /** How many processes the entry stands for (test forks, vitest workers). */
  count: number
  image: string
  /** Surefire only: tests finished so far, and the total of the last full run (absent for `-Dtest=` or before any). */
  progress?: { done: number; total?: number }
  /** First time this mod saw the entry (epoch ms). */
  since: number
  minutes: number
}

// Tasks for the person: from human-in-the-loop 0.1.8 by Tzafrir Rehan (MIT).
/**
 * What Claude needs from the user: something done (`do`), an answer in
 * their own words (`answer`), or one of a few options (`choose`).
 */
export type TaskKind = 'do' | 'answer' | 'choose'

/**
 * Where a task stands: waiting for the user (`open`), fulfilled (`done`),
 * turned down (`rejected`), or taken back by Claude (`withdrawn`).
 */
export type TaskState = 'open' | 'done' | 'rejected' | 'withdrawn'

/**
 * Whether Claude has heard of the user's latest move on the task: nothing
 * to tell (`none`), told nothing yet (`pending`), or told (`delivered`).
 */
export type TaskUpdate = 'none' | 'pending' | 'delivered'

/** A task Claude gave the user. */
export type Task = {
  /** Counts up per project: #1, #2, … */
  id: number
  title: string
  why: string
  doneWhen?: string
  kind: TaskKind
  options?: readonly string[]
  state: TaskState
  /** The user's answer, or the option they chose. */
  answer?: string
  /** Why the user rejected it, or why Claude withdrew it. */
  reason?: string
  update: TaskUpdate
  /** The session that assigned it. */
  sessionId: string
  createdMs: number
  updatedMs: number
}

/**
 * A task as the session that held it numbered it, and when it was assigned:
 * where two sessions drew one number, that tells their tasks apart.
 */
export type TaskRef = { id: number; createdMs: number }

/**
 * The tasks one session took on from another that had ended or gone quiet,
 * as that session numbered them, and when. `isEnded`: it had ended, so it
 * won't come back for them.
 */
export type Took = { tasks: readonly TaskRef[]; atMs: number; isEnded?: boolean }

/**
 * The selected task's field, when the pane shows one in place of its
 * buttons: an answer, or a reason for rejecting. `held` is an answer held
 * back because it looks like a secret.
 */
export type Editing = {
  id: number
  field: 'answer' | 'reason'
  held?: string
}

// ---- Rewritten part (clean-room, see SPEC.md). The state keys below are used by kept modules; add the rest. ----

declare module 'claude-code' {
  interface PluginState {
    'chat-sidecar': {
      /** Tasks Claude gave the person (from human-in-the-loop). */
      tasks: readonly Task[]
      nextId: number
      /** The tasks this session took on from others, by their session id. */
      took: Readonly<Record<string, Took>>
      editing: Editing | null
      loadedFor: string | null
      isWorking: boolean
      /** `live.held` (responses that never go alone at turn end), kept across a module reload. */
      held: readonly string[]
      /** True while Tasks for me previews the open tasks of other folders (the Elsewhere button). */
      elsewhere: boolean
      /** Other folders' open tasks as the last scan found them (a press on Elsewhere, a heartbeat while it is open). */
      elsewhereList: readonly { folder: string; task: Task }[]
      /** True while Tasks for me lists this session's closed tasks (Answered). */
      answeredOpen: boolean
      /** Servers on the watched ports and test runs, for the Background section. */
      listeners: Shaped<Listener[]>
      /** The Git section's facts for the session's folder; null outside a repo or with the section off. */
      git: GitInfo | null
      /** Background: the port whose details are open, and whether groups with nothing up are folded away. */
      bgOpen: number | null
      bgHideIdle: boolean
    }
  }
}
