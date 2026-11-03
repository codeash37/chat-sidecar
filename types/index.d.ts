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

/** A plan step's status. */
export type PlanStatus = 'pending' | 'in_progress' | 'completed'

/** One step of the chat's plan. */
export type PlanStep = { text: string; status: PlanStatus; activeForm?: string; id?: string }

/** The chat's plan: one per chat, every change raises `stamp`. */
export type Plan = { title: string; steps: readonly PlanStep[]; stamp: number }

/** The plan band's "shown" flag, whether the plan it last saw was all done, and that plan's stamp. */
export type BandState = { shown: boolean; allDone: boolean; stamp: number }

/** The settings screen: open, the ports error and the ports draft. */
export type SettingsScreen = { open: boolean; portsError: string | null; portsDraft: string | null }

/** What kind of call a subagent step is; each has its own tag colour. */
export type StepKind = 'read' | 'write' | 'command' | 'web' | 'skill' | 'subagent' | 'connector' | 'tool'

/** One call of a subagent, as its card shows it. */
export type Step = { kind: StepKind; label: string; dim?: string; live: string }

/** A subagent's card. */
export type Card = {
  id: string
  description: string
  type: string
  model: string
  effort: string
  phase: HelperPhase
  startMs: number
  endMs?: number
  /** Every call it made; `steps` keeps the newest 200. */
  calls: number
  steps: readonly Step[]
  /** Finished turns' tokens, and the turn in progress's. */
  tokens: number
  turnTokens: number
  usageSeen: boolean
  seat: number
  /** Index into the 8 card colours. */
  color: number
  /** The agent whose loop spawned it (an orchestrator); absent when the main chat did. */
  parentId?: string
}

/** The Subagents section's view: expanded cards and folded groups. */
export type CardsView = { expanded: readonly string[]; folded: readonly string[] }

/** One connector call. `at` is unknown (null) for a seeded call without a transcript time. */
export type ConnectorCall = { text: string; summary: string; at: number | null; cli: boolean }

export type ConnectorRow = { key: string; name: string; count: number; order: number; cli: boolean; mcp: boolean; calls: readonly ConnectorCall[] }

/** A context file; `auto` when loaded at start as a memory file. */
export type FileRow = { path: string; order: number; auto: boolean }

export type SkillRow = { name: string; count: number; order: number; always: boolean }

/** What the chat used: connectors, context files and skills. */
export type Inventory = { connectors: readonly ConnectorRow[]; files: readonly FileRow[]; skills: readonly SkillRow[] }

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
      /** switches.json mirrored: the mod is off, the pane is hidden. */
      off: boolean
      hidden: boolean
      /** Folded section ids (`tasks` included). */
      folded: readonly string[]
      /** The settings screen. */
      settings: SettingsScreen
      /** The pane was opened by itself this session. */
      autoOpened: boolean
      /** The session id whose history was seeded (plan, connectors, files, skills). */
      seededFor: string | null
      /** The chat's plan, and the band's flag. */
      plan: Plan
      band: BandState
      /** Connectors, context files and skills used. */
      inventory: Inventory
      /** The connector whose call list is open (row key). */
      openConnector: string | null
      /** The first visible Context files row. */
      filesTop: number
      /** Subagent cards, their view, and the animation clock. */
      cards: readonly Card[]
      cardsView: CardsView
      clock: number
      /** The plan band's shimmer tick. */
      shimmer: number
    }
  }
}
