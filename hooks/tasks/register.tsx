// From human-in-the-loop 0.1.8 by Tzafrir Rehan (MIT, see LICENSE-human-in-the-loop), adapted for chat-sidecar: see UPSTREAM.md.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitResult, Register, RenderElement, RenderSurface, Timer, ToolSpec } from 'claude-code'

import type { Editing, Task, Took } from '../../types'
import {
  MAX_OPEN,
  MAX_TITLE,
  answerIn,
  assignedOf,
  bridgeOf,
  contextOf,
  digestOf,
  isActive,
  isShown,
  listOf,
  looksSecret,
  messageOf,
  newsHeadOf,
  ownHeadOf,
  parseAsk,
  sameAsk,
  statusOf,
} from './tasks'
import {
  ANSWER_LABEL,
  BUTTON_GAP,
  HELD,
  MAX_SHOWN_TITLE,
  REASON_LABEL,
  REASON_PLACEHOLDER,
  actionsOf as actionsFor,
  ageOf,
  answerButtonsOf,
  answerPlaceholderOf,
  answeredOf,
  doneWhenOf,
  fieldKeyOf,
  placeholderOf,
  savedOf,
  submitLabelOf,
  titleOf,
  whyOf,
} from './pane'
import type { PaneView } from './pane'
import {
  HEARTBEAT_MS,
  adopt,
  editedLegacy,
  elsewhereIn,
  floorOf,
  hasLegacyPeer,
  isEmptyEdit,
  isSameTask,
  isSlot,
  isTakenFrom,
  keysOf,
  legacyOf,
  projectOf,
  prune,
  withSlots,
} from './project'
import type { Adoption, LegacyEdit, Project, Slot } from './project'
import { ago, numbersOf, oneLine, printable } from './text'
import { tasksElsewhere } from './elsewhere'
import { sidecarShowTasks } from '../register'
import type { ElsewhereTask } from './elsewhere'

const PLUGIN = 'chat-sidecar'

const ASSIGN = 'mcp__chat-sidecar__assign_task'
const LIST = 'mcp__chat-sidecar__list_tasks'
const WITHDRAW = 'mcp__chat-sidecar__withdraw_task'

/**
 * Three lines at the end of the system prompt: where an ask for the user goes
 * so it stays in front of them, that a review is one even when the reply asks
 * for it too (the user is often busy and lets the reply's question go by),
 * and where they see it. Said as what to do,
 * never what not to: nothing here stops Claude reminding the user of a task.
 */
const STEERING = [
  "When you need something only the user can do (a secret put in place, an action on their machine or an account you can't reach, a decision that's theirs), assign it with mcp__chat-sidecar__assign_task so it stays in front of them until they act on it.",
  'That includes asking the user to review or approve your work: assign it as a task even when you also ask in your reply, since they may be busy with other things when you ask, and the task keeps it in front of them.',
  'The user sees open tasks in Tasks for me in their chat sidecar, or brings it up with /my-tasks, and their response reaches you as a message.',
].join('\n')

/** Resolutions pressed this close together go to Claude as one message. */
const BATCH_MS = 800

/** The longest a person, or Claude, waits on the store: what it doesn't answer by then finishes on its own. */
const STORE_WAIT_MS = 5000

/** What a tool answers while the session moves to another folder, before it has read that folder's tasks. */
const MOVING = 'This session is still joining its project: the task store is slow to answer. Try again in a moment.'

// chat-sidecar: the tasks are drawn in the chat sidecar's pane, in its Tasks for me section; `/my-tasks` brings it up.
const SIDECAR = 'chat-sidecar'

/** What a field and its buttons draw under a task: the field, and the buttons in the task's indent. */
type Controls = readonly [field: RenderElement | null, buttons: RenderElement | null]

/** The elements a surface draws with, as `$.ui.resolve` hands them. */
type Elements = ReturnType<EngineInterface['ui']['resolve']>

/** chat-sidecar: what the chat sidecar lends the task part ($ goes only to function declarations, so `show` is imported). */
export type TasksHost = {
  /** The sidecar is on: a task assigned now can be seen and answered. */
  isOn: () => boolean
}

const TOOLS: readonly ToolSpec[] = [
  {
    name: 'assign_task',
    description: [
      'Give the user a task that only they can do, and keep it in front of them until they act on it.',
      'Use it for a secret or credential they must put in place, an action on their machine or on an account you cannot reach (a dashboard, a device, a deploy approval), a decision that is theirs to make, or a review or approval of your work.',
      'Assign it even when you also ask in your reply: the user may be busy with other things, and the task keeps the ask in front of them.',
      'A task does not block: you keep working while it waits, and the response reaches you whenever the user gets to it, so it suits anything you need from them at some point in the session.',
      'AskUserQuestion is the blocking kind: it waits for the answer, so it suits what you need before you can go on.',
      'One task per need: list_tasks shows what is already open.',
      'Write the title as an imperative the user can act on without scrolling back.',
      'For a secret, ask the user to put it where it belongs and mark the task done, rather than paste it.',
      'The user sees open tasks in Tasks for me in their chat sidecar, or brings it up with /my-tasks.',
      'The user rejects (with a reason) or fulfills it (done, an option, or an answer in their words). Their response reaches you as a message, or when you call list_tasks.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'What the user should do, as an imperative they can act on without scrolling back. Under 80 characters.',
        },
        why: {
          type: 'string',
          description: 'One sentence: what it unblocks, or why only the user can do it.',
        },
        done_when: {
          type: 'string',
          description: "Optional: what counts as done. For a secret: \"It is in .env. Don't paste it here.\"",
        },
        kind: {
          type: 'string',
          enum: ['do', 'answer', 'choose'],
          description: 'do: the user does something and marks it done. answer: you need their words (an error, a log, test results). choose: they pick one of options.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 4,
          description: 'For choose only: 2 to 4 short options.',
        },
      },
      required: ['title', 'why', 'kind'],
    },
  },
  {
    name: 'list_tasks',
    description: [
      'List the tasks you gave the user and what they did with them: accepted, done (with their answer or choice), rejected (with their reason).',
      'Call it when you are about to need a task\'s result, when told an answer is saved for you, or before assigning, to avoid a duplicate.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        show: {
          type: 'string',
          enum: ['updates', 'open', 'all'],
          description: 'updates (the default): open tasks and responses you have not seen. open: open tasks only. all: every task this session.',
        },
        id: { type: 'number', description: 'One task, whole, by its number.' },
      },
    },
  },
  {
    name: 'withdraw_task',
    description: 'Take back a task you gave the user when you no longer need it: you found another way, or the plan changed. The user sees the reason.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The task\'s number.' },
        reason: { type: 'string', description: 'One short sentence the user sees.' },
      },
      required: ['id'],
    },
  },
]

const tasks = atom({ plugin: 'chat-sidecar', key: 'tasks' } as const, [] as readonly Task[])
const nextId = atom({ plugin: 'chat-sidecar', key: 'nextId' } as const, 1)
const took = atom({ plugin: 'chat-sidecar', key: 'took' } as const, {} as Readonly<Record<string, Took>>)
const editing = atom({ plugin: 'chat-sidecar', key: 'editing' } as const, null as Editing | null)
const loadedFor = atom({ plugin: 'chat-sidecar', key: 'loadedFor' } as const, null as string | null)
const isWorking = atom({ plugin: 'chat-sidecar', key: 'isWorking' } as const, false)
// chat-sidecar: a copy of `live.held`, so a module reload (any userConfig change) does not send a held response alone at turn end.
const heldKeys = atom({ plugin: 'chat-sidecar', key: 'held' } as const, [] as readonly string[])
// chat-sidecar: whether Elsewhere is expanded, and what its last scan found (scanned as the session joins, on a press
// and on every heartbeat, never in a render: the sidecar draws every 300 ms while a subagent runs).
const elsewhereOpen = atom({ plugin: 'chat-sidecar', key: 'elsewhere' } as const, false)
const elsewhereList = atom({ plugin: 'chat-sidecar', key: 'elsewhereList' } as const, [] as readonly ElsewhereTask[])
// chat-sidecar: whether Answered, this session's closed tasks, is expanded.
const answeredOpen = atom({ plugin: 'chat-sidecar', key: 'answeredOpen' } as const, false)
let host: TasksHost = { isOn: () => true }

/**
 * Send now goes to Claude as a message (`auto` while it is idle), Save for
 * later waits (`auto` while it works) until its turn ends with every task
 * answered, a later answer while it is idle, or the user's next prompt.
 */
type How = 'auto' | 'now' | 'later'

/**
 * What a toast says when a prompt carrying updates is dropped: why (`why`,
 * the mod's own prompt, which the user didn't type), only that they're kept
 * (`kept`, an answer the user typed, whose drop the engine shows), or nothing
 * (`nothing`, the user's own prompt, which they rode: they wait as before).
 */
type DropNote = 'why' | 'kept' | 'nothing'

/** A prompt as it entered: its words, and the blocks that go beside them. */
type Entered = { text: string; context?: readonly string[] }

/**
 * What a sync changed of what the session shows: nothing (`same`), the tasks
 * another session took on (`lost`), or everything, taking the project on
 * (`joined`).
 */
type Synced = 'same' | 'lost' | 'joined'

/** What the module tracks beside `$.state`; a hot reload starts it over. */
const live = {
  sessionId: '',
  root: '',
  /** The folder the latest join is for, set as it is asked: `root` follows in queue order. */
  joinRoot: '',
  /** A Send now row joined the running turn and no step has read it yet. */
  isUnread: false,
  /** A Send now the running turn could not take: it goes once the turn ends. */
  isSendingAtEnd: false,
  /** What the user has typed in each field so far, by `fieldKeyOf`. */
  drafts: new Map<string, string>(),
  /**
   * What was typed in each answer field as its task closed, by `fieldKeyOf`:
   * a button pressed on a drawing from before the task closed answers with it.
   */
  closed: new Map<string, string>(),
  /**
   * What each surface draws each field with, by `fieldKeyOf`: the draft as
   * the surface first drew it. It stays put while the field is typed in, as a
   * value drawn anew puts the field's text back to it, keys typed meanwhile
   * lost. A surface that forgets what its fields hold (the pane closed, or a
   * client of it came) draws them with the draft again.
   */
  drawn: new Map<RenderSurface, Map<string, string>>(),
  batch: null as Timer | null,
  /** Says in the project's store that this session is alive. */
  heartbeat: null as Timer | null,
  /** Tasks waiting in the project's other live sessions. */
  elsewhere: 0,
  /** The project's next task number at its last reading. */
  floor: 1,
  /** A 0.1.4 session was alive in the project at its last reading. */
  hasLegacyPeer: false,
  /** The session has a slot in the project's store: it writes it, its count in it, until it ends. */
  hasSlot: false,
  /** When the session's slot was last written. */
  writtenMs: 0,
  /** When the session last read the project. */
  readMs: 0,
  /** Set once the session ended: its slot says so from then on. */
  endedMs: undefined as number | undefined,
  /** How many sessions of the process have ended: one that ends before its join comes up in the queue stays ended. */
  ends: 0,
  /** Responses a prompt entered without, by `updateKeyOf`: they go with Send now, the next prompt or another response, never alone as a turn ends. */
  held: new Set<string>(),
  /** Joins into another folder not done yet: until then the tasks the process holds are the folder's it leaves. */
  moving: 0,
  /** The store work asked for and not yet done: each piece waits for the one before. */
  queue: Promise.resolve() as Promise<unknown>,
  /** Store work a wait gave up on, not settled yet: while there is any, nothing waits on the store. */
  stalled: 0,
  /**
   * Turns begun and not yet ended. `turn.start` names no loop, so a loop
   * other than main's (an engine side request, a teammate) may begin one that
   * ends under an agent id: each ends by its own id.
   */
  turns: new Set<string>(),
  /** Whether a turn runs, in the engine's own word (the band's `isWorking`), once it has said. */
  engineWorking: undefined as boolean | undefined,
  /** The key of the element the sidecar's focus ring last moved onto. */
  ring: undefined as string | undefined,
  /** chat-sidecar: the store's keys at the last read of the project, for Elsewhere. */
  storeKeys: undefined as readonly string[] | undefined,
}

/** Whether Claude is at work: the engine's word when it has given one, else the turns begun and not ended. */
function working(): boolean {
  return live.engineWorking ?? live.turns.size > 0
}

// chat-sidecar: the four hooks chat-sidecar registers too live in its own module as one hook each (a module takes an
// event once); these are their task parts, which chat-sidecar calls where this plugin's hook stood around next(e).

/** session.start, before next: the tools, /my-tasks, and this session's place in the project. */
export async function tasksOnSessionStart($: EngineInterface) {
  for (const tool of TOOLS) {
    await $.tool.register(tool)
  }

  await $.command.register({ name: 'my-tasks', description: 'Bring up Tasks for me in the chat sidecar' })
  for (const key of await read($, heldKeys)) live.held.add(key)
  // chat-sidecar: the My tasks pane of 0.3.0 and before, left on screen by a reload of the code.
  await $.ui.close({ id: 'my-tasks' }).catch(() => undefined)
  await join($)
}

/**
 * chat-sidecar: before the sidecar opens. A pane that was closed forgets what its fields held, so they are drawn with
 * their drafts again, and its ring starts on the open field. Asked only with a draft or a field open; when the engine
 * can't say, they are drawn so anyway.
 */
export async function tasksBeforeOpen($: EngineInterface) {
  if (live.drafts.size > 0 || (await read($, editing)) !== null) {
    const panes = await $.ui.panes().catch(() => undefined)

    if (panes === undefined || !panes.some(pane => pane.id === SIDECAR)) {
      live.drawn.clear()
      live.ring = openKeyOf(await read($, editing))
    }
  }
}

/** chat-sidecar: the sidecar drew `surface` without Tasks for me (folded, settings, hidden): its fields start over with their drafts. */
export function tasksUndrawn(surface: RenderSurface) {
  live.drawn.delete(surface)
}

/** chat-sidecar: brings up Tasks for me, as /my-tasks does. */
export function tasksShow($: EngineInterface): Promise<boolean> {
  return show($, true)
}

/** turn.step, before next. */
export function tasksOnTurnStep(e: { agentId?: string }) {
  if (e.agentId === undefined) {
    live.isUnread = false
  }
}

/** turn.complete, after next: the turn bookkeeping, and the answers saved while Claude worked. */
export async function tasksOnTurnComplete($: EngineInterface, e: { agentId?: string; turnId: string }) {
  // Main's turn ending ends every turn; another loop's ends its own.
  if (e.agentId === undefined) {
    live.turns.clear()
    live.engineWorking = false
  } else {
    live.turns.delete(e.turnId)
  }

  await syncWorking($)

  if (e.agentId === undefined) {
    // Answers saved while Claude worked go now that it's free, unless a
    // task is still open: then they go with that last answer, together.
    // One a prompt entered without goes with them, but sends nothing alone.
    const all = await read($, tasks)
    const isAllAnswered = all.some(task => task.update === 'pending' && !live.held.has(updateKeyOf(task))) && !all.some(isActive)

    if (live.isSendingAtEnd || isAllAnswered) {
      live.isSendingAtEnd = false
      // This message wakes Claude, which reads any row it missed above it.
      live.isUnread = false
      void send($, true)
    } else if (live.isUnread) {
      // A Send now that joined the turn during its final reply sits in the
      // conversation with no step left to read it: wake Claude up for it.
      live.isUnread = false
      void $.prompt.submit({ text: 'I answered a task while you were finishing your reply; my answer is above.', asUser: true })
    }
  }
}

/**
 * ui.render AbovePrompt, before next: draws nothing, only reads the engine's word on whether a turn runs,
 * which no turn event gives for every loop.
 */
export function tasksOnAbovePrompt($: EngineInterface, isWorking: boolean) {
  if (live.engineWorking !== isWorking) {
    live.engineWorking = isWorking
    $.clock.after(0, () => void syncWorking($))
  }
}

export const registerTasks = (on: Parameters<Register>[0], options?: Parameters<Register>[1], lent?: TasksHost) => {
  if (lent !== undefined) host = lent

  // An ended session's tasks wait in the store for the next session in the
  // project. After /clear or a resume the process goes on as another session
  // with no session.start, so it joins the project again here.
  on('session.end', async ($, e, next) => {
    live.heartbeat?.cancel()
    live.heartbeat = null
    live.endedMs = await $.clock.now()
    live.ends += 1
    const ends = live.ends

    // The slot marked ended, in one write and no read, once the store work in
    // flight is done; a session that never read the project reads it first.
    // The exit's budget is short, and the end waits for the write only
    // through half of what is left: a slot not written by then goes stale,
    // and the next session takes it on then. A process that goes on makes
    // the write all the same, before it joins again.
    const written = queued(async () => ((await isLoaded($)) ? writeOwn($) : load($))).catch(() => undefined)
    const leftMs = next.budget.remainingMs

    await (Number.isFinite(leftMs) ? Promise.race([written, $.clock.sleep(leftMs / 2)]) : written)

    const ended = await next(e)

    if (e.reason === 'clear' || e.reason === 'resume') {
      // With the count as this session ended: the next one, ending before
      // the join runs, stays ended.
      $.clock.after(0, () => void join($, ends))
    }

    return ended
  })

  on('command.run', { command: 'my-tasks' }, async $ => {
    if (!host.isOn()) {
      return { text: OFF_TEXT }
    }

    await wake($)

    return (await show($, true)) ? {} : { text: "The chat sidecar couldn't open here; type /chat-sidecar." }
  })

  // The tools stay in the prompt's list, descriptions and all, where an MCP
  // tool would wait behind ToolSearch: the description is what steers Claude
  // to assign a task, so the ask stays in front of the user.
  on('tool.describe', { tool: ASSIGN }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: LIST }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: WITHDRAW }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: ASSIGN }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'Only the main agent assigns tasks to the user. Say what you need from the user in your result instead.' }
    }

    // chat-sidecar: turned off, nothing would show the task.
    if (!host.isOn()) {
      return { deny: 'The user turned the chat sidecar off, so they would not see a task. Ask them in your reply instead.' }
    }

    const ask = parseAsk(e as unknown as Record<string, unknown>)

    if ('error' in ask) {
      return { deny: ask.error }
    }

    // Resumed into another folder, the session takes it on once the store
    // work in flight is done and it has read it. A task assigned before then
    // is the old folder's: the join drops it here, and the old session's end
    // write may leave it there.
    if (live.moving > 0) {
      return { deny: MOVING }
    }

    // Task numbers count per project, across its sessions: the next is past
    // every number a session there drew, which each slot carries, so this
    // reads the project first (and lets go of tasks taken on while the
    // session slept). Two sessions assigning at the same moment can still
    // draw one number; each shows and answers only its own, and where their
    // tasks meet (one taking on the other's), `adopt` gives the later a new one.
    await beat($, false)

    const active = (await read($, tasks)).filter(isActive)
    const same = active.find(task => sameAsk(task.title, ask.title))

    if (same !== undefined) {
      return { result: `Task #${same.id} already asks the user for this ("${same.title}"); nothing new was assigned.` }
    }

    if (active.length >= MAX_OPEN) {
      return {
        deny: `The user already has ${MAX_OPEN} open tasks. Withdraw one you no longer need, or wait for them to act (list_tasks shows them).`,
      }
    }

    const id = (await update($, nextId, n => Math.max(n, live.floor) + 1)) - 1
    const nowMs = await $.clock.now()
    const task: Task = {
      id,
      ...ask,
      state: 'open',
      update: 'none',
      // The conversation's own: until it joins the project (a store slow
      // after /clear), the process still acts for the one it left.
      sessionId: await $.session.id(),
      createdMs: nowMs,
      updatedMs: nowMs,
    }

    await change($, list => [...list, task])

    if (live.hasLegacyPeer) {
      await awaited($, queued(() => editLegacy($, { removed: [], taken: {} })))
    }

    if (!(await show($, false))) {
      $.ui.toast(`Claude assigned you a task: ${printable(task.title, MAX_TITLE)}. See Tasks for me (/my-tasks)`)
    }

    return { result: assignedOf(task, active.length + 1) }
  })

  on('tool.call', { tool: LIST }, async ($, e) => {
    if (live.moving > 0) {
      return { deny: MOVING }
    }

    await wake($)
    const args = e as unknown as Record<string, unknown>
    const id = typeof args['id'] === 'number' ? args['id'] : undefined
    const scope = args['show'] === 'open' || args['show'] === 'all' ? args['show'] : 'updates'
    const list = await read($, tasks)

    const picked =
      id !== undefined
        ? list.filter(task => task.id === id)
        : scope === 'all'
          ? list
          : scope === 'open'
            ? list.filter(isActive)
            : list.filter(isShown)

    if (id !== undefined && picked.length === 0) {
      return { result: `No task #${id}.` }
    }

    // A subagent's read tells the main agent nothing. Claude hears the
    // responses this shows: one that came in after it read goes later.
    if (e.agentId === undefined) {
      await claim($, task => picked.some(one => one.id === task.id && one.update === 'pending'))
    }

    return { result: listOf(picked, await $.clock.now()) }
  })

  on('tool.call', { tool: WITHDRAW }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'Only the main agent withdraws tasks.' }
    }

    if (live.moving > 0) {
      return { deny: MOVING }
    }

    await wake($)
    const args = e as unknown as Record<string, unknown>
    const id = args['id']
    const reason = typeof args['reason'] === 'string' ? oneLine(args['reason']) : ''
    const task = (await read($, tasks)).find(one => one.id === id)
    // Withdrawn only while it is open: an answer the user gave a moment before stands.
    const found =
      task === undefined || !isActive(task)
        ? task
        : await edit($, task.id, one => ({
            ...one,
            state: 'withdrawn',
            update: 'delivered',
            ...(reason === '' ? {} : { reason }),
          }))

    if (found === undefined) {
      return { deny: `No task #${String(id)}.` }
    }

    if (!isActive(found)) {
      return { deny: `Task #${found.id} is already ${found.state}; there is nothing to withdraw.` }
    }

    // Its fields go with it, and what was typed in them: put in the prompt
    // box unasked, it would join whatever the user is writing there.
    await settle($, found.id)
    const why = reason === '' ? '' : `. ${printable(reason, 200)}`
    $.ui.toast(`Claude withdrew the task: ${printable(found.title, MAX_TITLE)}${why}`, { timeoutMs: 8000 })

    return { result: `Withdrew task #${found.id}; it is gone from the user's Tasks for me.` }
  })

  on('turn.start', async ($, e, next) => {
    live.isUnread = false
    live.turns.add(e.turnId)
    await syncWorking($)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if ((e.origin.kind === 'plugin' && e.origin.name === PLUGIN) || live.moving > 0) {
      return next(e)
    }

    await wake($)
    const bridged = answerIn(e.text)
    const task = bridged === null ? undefined : (await read($, tasks)).find(one => one.id === bridged.id && isActive(one))
    let isAnswered = false

    if (bridged !== null && task !== undefined) {
      if (looksSecret(bridged.answer)) {
        return {
          drop: `This looks like a secret, so it wasn't sent. Put it where it belongs, then mark #${task.id} Done.`,
        }
      }

      const given = bridged.answer === '' ? {} : { answer: bridged.answer }

      if (e.turnId === undefined) {
        // Claude is idle: this prompt is the answer, sent with every other
        // update Claude has not heard, those a batch was about to send among them.
        live.batch?.cancel()
        live.batch = null
      }

      // A task closed meanwhile (Claude withdrew it, say) keeps no answer:
      // the prompt goes as typed.
      const was = await resolve($, task.id, { state: 'done', ...given }, 'later')
      isAnswered = was !== undefined && isActive(was)

      if (isAnswered && e.turnId !== undefined) {
        const when = (await read($, tasks)).some(isActive) ? 'with your other answers' : 'when this turn ends'

        return {
          drop: `Saved as your answer to #${task.id}. Claude gets it ${when}, or press Send now in Tasks for me.`,
        }
      }
    }

    const due = await claim($)
    // A task still here has its answer in this prompt, or in another send
    // that took it as it was saved. One gone meanwhile (another session took
    // it on) leaves the prompt as typed.
    const isAnswer = isAnswered && task !== undefined && (await read($, tasks)).some(one => one.id === task.id)

    if (isAnswer && due.length === 0) {
      return { drop: `Your answer to #${task.id} already went to Claude.` }
    }

    if (due.length === 0) {
      return next(e)
    }

    if (isAnswer) {
      return passOn($, due, inWords, 'kept', () => next({ ...e, text: messageOf(due) }))
    }

    return passOn($, due, inDigest, 'nothing', () => next({ ...e, context: [...(e.context ?? []), digestOf(due)] }))
  })

  // Read at a conversation's start and again after a compaction: what is
  // still with the user, so Claude neither forgets nor assigns it twice.
  // Added last, on the session's side of the cache boundary, wherever the
  // tool can be reached: offered outright, or found through ToolSearch.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const isReachable = e.tools.some(tool => tool === ASSIGN || tool === 'ToolSearch')

    if (!isReachable || e.traits.includes('print') || e.traits.includes('bare')) {
      return composed
    }

    return { sections: [...composed.sections, { id: 'chat-sidecar:tasks', text: STEERING, scope: 'session' }] }
  })

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const shown = (await read($, tasks)).filter(isShown)

    if (shown.length === 0 || live.moving > 0) {
      return result
    }

    return { ...result, blocks: [...result.blocks, { name: 'tasksForMe', text: contextOf(shown, await $.session.id()) }] }
  })

  on('ui.render', { component: 'ToolUse', props: { tool: ASSIGN } }, ($, e, next) => {
    const input = e.props.input as Record<string, unknown> | null | undefined
    const title = typeof input?.['title'] === 'string' ? input['title'] : ''

    if (title === '' || e.props.isErrored || e.props.isInterrupted) {
      return next(e)
    }

    const { Text } = $.ui.resolve(e)

    return (
      // One text, so the label keeps its words whole and the title wraps after it.
      <Text wrap="wrap">
        <Text color="yellow">{'☐ '}</Text>
        <Text bold>{'Assigned you a task: '}</Text>
        {printable(title, MAX_SHOWN_TITLE)}
      </Text>
    )
  })

  // A second client on a surface (two phones) draws the fields with what is typed in them so far.
  on('session.attach', async ($, e, next) => {
    live.drawn.delete(e.surface)
    return next(e)
  })

  // The ring on a field says the person is typing there.
  on('ui.focus', { requestId: SIDECAR }, async ($, e, next) => {
    const moved = await next(e)

    if (moved.deny === undefined) {
      live.ring = e.element
    }

    return moved
  })
}

/** What /my-tasks answers while the sidecar is off. */
const OFF_TEXT = 'The chat sidecar is off, so tasks are not shown: remove "chat-sidecar": false from ~/.claude/mods/switches.json.'

/** A card's bar: its cells, and its colour while a field is open; the buttons that answer, in their colour. */
const BAR_CELLS = 1
const FIELD_COLOR = 'suggestion'
const ANSWER_COLOR = 'claude'

/** Answered shows this many of the session's closed tasks. */
const MAX_ANSWERED = 5

/**
 * chat-sidecar: the body of the sidecar's Tasks for me section, `columns` wide: every open task whole with its
 * buttons, the responses not sent yet, Answered and Elsewhere. Drawn by the sidecar's Pane hook (`els`, `surface`).
 */
export async function tasksSection($: EngineInterface, els: Elements, surface: RenderSurface, isFocused: boolean, columns: number): Promise<RenderElement> {
  const { Box, Text, Button } = els
  // The mobile app draws no field yet: answers and reasons wait for a surface that does. The engine fills an element a
  // surface lacks with one that draws nothing, so the surface says, not the table.
  const Input = surface !== 'mobile' && 'Input' in els ? els.Input : undefined
  const view = await paneView($, { canType: Input !== undefined, isFocused })
  const { shown, editing: field, isWorking: working } = view
  const active = shown.filter(isActive)
  const saved = shown.filter(task => !isActive(task))
  // A card's inside: the section's less its bar and the gap after it.
  const cardColumns = Math.max(1, columns - BAR_CELLS - 1)

  // The glyph keeps its cells beside a title that wraps.
  const glyph = (
    <Box flexShrink={0}>
      <Text color="yellow">{'☐ '}</Text>
    </Box>
  )

  // A button that answers in the accent colour, one that steps back (Reject, Cancel) dim: buttons don't read as text.
  const labelOf = (label: string, isBack = false) => (isBack ? <Text dimColor>{label}</Text> : <Text color={ANSWER_COLOR}>{label}</Text>)

  // No hotkeys: the sidecar takes the keys on any click, and a digit typed for the prompt would answer a task.
  const actionsOf = (task: Task) => (
    <Box key="actions" flexDirection="row" flexWrap="wrap" columnGap={BUTTON_GAP}>
      {actionsFor(task, view.canType).map(action => (
        <Button
          key={actionKeyOf(task, action.key)}
          plain
          onPress={() => {
            if (action.option !== undefined) {
              return respond($, task.id, { state: 'done', answer: action.option }, 'auto')
            }

            if (action.key === 'done') {
              return respond($, task.id, { state: 'done' }, 'auto')
            }

            if (action.key === 'answer') {
              return startEditing($, task.id, 'answer')
            }

            return view.canType ? startEditing($, task.id, 'reason') : respond($, task.id, { state: 'rejected' }, 'auto')
          }}
        >
          {labelOf(action.label, action.key === 'reject')}
        </Button>
      ))}
    </Box>
  )

  const answerField = (task: Task, held: string | undefined): Controls => {
    if (Input === undefined) {
      return [null, null]
    }

    if (held !== undefined) {
      return [
        null,
        <Box key="held" flexDirection="column">
          <Text color="yellow" wrap="wrap">
            {HELD}
          </Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={BUTTON_GAP}>
            <Button key="t-edit" plain onPress={() => startEditing($, task.id, 'answer')}>
              {labelOf('Edit')}
            </Button>
            <Button key="t-send-anyway" plain onPress={() => answer($, task.id, held, 'auto', true)}>
              {labelOf('Send anyway', true)}
            </Button>
          </Box>
        </Box>,
      ]
    }

    const key = fieldKeyOf({ id: task.id, field: 'answer' })
    const submitLabel = submitLabelOf('answer', view)
    const [otherWay, long, cancel] = answerButtonsOf(view)

    return [
      <Input
        key={key}
        label={ANSWER_LABEL}
        placeholder={placeholderOf(answerPlaceholderOf(view), ANSWER_LABEL, submitLabel, cardColumns)}
        value={fieldValueOf(surface, key)}
        submitLabel={submitLabel}
        autoFocus
        onInput={value => typed(key, value)}
        onSubmit={value => answer($, task.id, value, 'auto')}
      />,
      <Box key="buttons" flexDirection="row" flexWrap="wrap" columnGap={BUTTON_GAP}>
        <Button key="t-other-way" plain onPress={() => answerTyped($, task.id, working ? 'now' : 'later')}>
          {labelOf(otherWay)}
        </Button>
        <Button key="t-long" plain onPress={() => longAnswer($, task.id)}>
          {labelOf(long)}
        </Button>
        <Button key="t-cancel" plain onPress={() => stopEditing($)}>
          {labelOf(cancel, true)}
        </Button>
      </Box>,
    ]
  }

  const reasonField = (task: Task): Controls => {
    if (Input === undefined) {
      return [null, null]
    }

    const key = fieldKeyOf({ id: task.id, field: 'reason' })
    const submitLabel = submitLabelOf('reason', view)

    return [
      <Input
        key={key}
        label={REASON_LABEL}
        placeholder={placeholderOf(REASON_PLACEHOLDER, REASON_LABEL, submitLabel, cardColumns)}
        value={fieldValueOf(surface, key)}
        submitLabel={submitLabel}
        autoFocus
        onInput={value => typed(key, value)}
        onSubmit={value => {
          const reason = oneLine(value)
          return respond($, task.id, { state: 'rejected', ...(reason === '' ? {} : { reason }) }, 'auto', reason)
        }}
      />,
      <Button key="t-cancel" plain onPress={() => stopEditing($)}>
        {labelOf('Cancel', true)}
      </Button>,
    ]
  }

  // Every open task whole: the sidecar has the room, and nothing needs selecting first.
  const card = (task: Task) => {
    const isEditing = view.canType && field !== null && field.id === task.id
    const [input, buttons]: Controls = !isEditing
      ? [null, actionsOf(task)]
      : field.field === 'answer'
        ? answerField(task, field.held)
        : reasonField(task)
    const doneWhen = doneWhenOf(task)

    // A bar down the card's left edge, in the warning colour, or the field's while one is open: the card where you type.
    return (
      <Box key={`task-${task.id}`} flexDirection="row" flexShrink={0}>
        <Box key="bar" width={BAR_CELLS} flexShrink={0} backgroundColor={isEditing ? FIELD_COLOR : 'warning'} />
        <Box key="card" flexDirection="column" flexGrow={1} flexShrink={1} paddingLeft={1}>
          <Box flexDirection="row">
            {glyph}
            {/* The title and its age are one text, so a long title wraps under itself and the age follows it. */}
            <Text wrap="wrap">
              <Text bold>{titleOf(task)}</Text>
              <Text dimColor>{ageOf(task, view)}</Text>
            </Text>
          </Box>
          <Box flexDirection="column" paddingLeft={2}>
            <Text dimColor wrap="wrap">
              {whyOf(task)}
            </Text>
            {doneWhen === undefined ? null : (
              <Text dimColor italic wrap="wrap">
                {doneWhen}
              </Text>
            )}
          </Box>
          {input}
          <Box flexDirection="column" paddingLeft={2}>
            {buttons}
          </Box>
        </Box>
      </Box>
    )
  }

  const savedRows = saved.map(task => (
    <Box key={`saved-${task.id}`} flexDirection="row" flexShrink={0}>
      <Box flexShrink={0}>{task.state === 'rejected' ? <Text color="red">{'✗ '}</Text> : <Text color="green">{'✓ '}</Text>}</Box>
      <Text dimColor wrap="wrap">
        {savedOf(task)}
      </Text>
      <Box flexShrink={0} marginLeft={2}>
        <Button key={`t-send-${task.id}`} plain label="Send now" onPress={() => sendNow($)} />
      </Box>
    </Box>
  ))

  // Answered: this session's closed tasks, newest first.
  const closed = (await read($, tasks)).filter(task => !isShown(task)).sort((a, b) => b.updatedMs - a.updatedMs)
  const isAnsweredOpen = await read($, answeredOpen)
  const answered =
    closed.length === 0 ? null : (
      <Box key="answered" flexDirection="column" marginTop={1} flexShrink={0}>
        <Box flexShrink={0}>
          <Button
            key="t-answered"
            plain
            dimColor={!isAnsweredOpen}
            label={`${isAnsweredOpen ? '▾' : '▸'} Answered (${closed.length})`}
            onPress={() => void update($, answeredOpen, was => !was)}
          />
        </Box>
        {isAnsweredOpen
          ? closed.slice(0, MAX_ANSWERED).map(task => {
              const { glyph: mark, color, text } = answeredOf(task)
              return (
                <Text key={`answered-${task.id}`} wrap="truncate-end">
                  <Text color={color}>{`${mark} `}</Text>
                  <Text>{text}</Text>
                  <Text dimColor>{`  ${ago(view.nowMs - task.updatedMs)}`}</Text>
                </Text>
              )
            })
          : null}
      </Box>
    )

  // Elsewhere: other folders' open tasks, as the last scan found them.
  const isElsewhereOpen = await read($, elsewhereOpen)
  const found = await read($, elsewhereList)
  const others = isElsewhereOpen ? found : []
  const elsewhere = (
    <Box key="elsewhere" flexDirection="column" marginTop={1} flexShrink={0}>
      <Box flexShrink={0}>
        <Button
          key="elsewhere-toggle"
          plain
          dimColor={!isElsewhereOpen}
          label={`${isElsewhereOpen ? '▾' : '▸'} Elsewhere (${found.length})`}
          onPress={() => void toggleElsewhere($)}
        />
      </Box>
      {isElsewhereOpen ? (
        <Text key="note" dimColor wrap="truncate-end">
          {others.length ? "Open in other folders; answer in that folder's session." : 'Nothing open in other folders.'}
        </Text>
      ) : null}
      {others.map(({ folder, task }, i) => (
        <Text key={`else-${i}`} wrap="truncate-end">
          <Text dimColor>{`${folder} `}</Text>
          <Text color="yellow">{`#${task.id} `}</Text>
          <Text>{task.title}</Text>
          <Text dimColor>{`  ${task.kind}`}</Text>
        </Text>
      ))}
    </Box>
  )

  return (
    <Box flexDirection="column">
      {shown.length === 0 ? (
        <Text key="none" dimColor>
          Nothing waiting for you.
        </Text>
      ) : null}
      {active.length > 0 ? (
        <Box key="task-cards" flexDirection="column" rowGap={1} flexShrink={0}>
          {active.map(card)}
        </Box>
      ) : null}
      {saved.length > 0 ? (
        <Box key="saved" flexDirection="column" marginTop={active.length > 0 ? 1 : 0} flexShrink={0}>
          {savedRows}
        </Box>
      ) : null}
      {answered}
      {elsewhere}
    </Box>
  )
}

/** The key of a task's button: its own, so a press names the task. */
function actionKeyOf(task: Task, action: string): string {
  return `t-${task.id}-${action}`
}

/** Expands or folds Elsewhere; expanded, it scans the store at once. */
async function toggleElsewhere($: EngineInterface) {
  if (await update($, elsewhereOpen, was => !was)) {
    await scanElsewhere($)
  }
}

/**
 * Reads the other folders' open tasks into `elsewhereList`; from `keys`, the store's keys as the project's read just
 * found them, it asks the store for nothing more than those folders' values. Nothing while store work is given up on.
 */
async function scanElsewhere($: EngineInterface, keys?: readonly string[]) {
  if (live.stalled > 0) {
    return
  }

  const found = await tasksElsewhere($, keys).catch(() => undefined)

  if (found !== undefined) {
    await update($, elsewhereList, () => found)
  }
}

/** Keeps the pane's word on whether Claude works (Enter sends, or saves) in step. */
async function syncWorking($: EngineInterface) {
  const now = working()

  await update($, isWorking, () => now)
}

/**
 * Joins the project as this session: takes on its tasks, the store's slot
 * kept alive by a heartbeat, the status line and, for tasks taken on from an
 * earlier session, the pane.
 */
async function join($: EngineInterface, ends = live.ends) {
  const sessionId = await $.session.id()
  const root = await $.session.root()
  // From the folder the latest join is for: one still queued takes the process there first.
  const isMoving = live.joinRoot !== '' && live.joinRoot !== root
  live.joinRoot = root

  // A row of the conversation the process leaves is none of this one's.
  live.isUnread = false

  // After /clear the process goes on as a new session, with no slot yet: it
  // takes over once the old session's writes are done, and takes on what
  // the old one held, ended whether or not its end write landed (or, when
  // the old one never read the project, what the one before it held).
  // Resumed in another folder, it leaves that folder's tasks as its last
  // write there left them and starts on this one as a new process would,
  // keeping nothing it tracked of that project. A store that fails now
  // takes nothing on yet: the session writes nothing until it has read the
  // project, which the heartbeat tries again.
  const joined = queued(async () => {
    if (live.root !== '' && live.root !== root) {
      await update($, tasks, () => [])
      await update($, nextId, () => 1)
      await update($, took, () => ({}))
      await update($, editing, () => null)
      await update($, loadedFor, () => null)
      live.drafts.clear()
      live.closed.clear()
      live.drawn.clear()
      live.held.clear()
      await update($, heldKeys, () => [])
      live.batch?.cancel()
      live.batch = null
      live.isSendingAtEnd = false
      live.elsewhere = 0
      live.floor = 1
      live.hasLegacyPeer = false
    }

    live.sessionId = sessionId
    live.root = root
    live.hasSlot = false
    live.writtenMs = 0
    live.readMs = 0

    // A session that ended while this waited in the queue (an exit right
    // after /clear, the store slow) reads the project as an ending session
    // does, and its end write, queued after this, marks its slot ended.
    if (live.ends === ends) {
      live.endedMs = undefined
    }

    return load($)
  }).catch(() => undefined)

  if (isMoving) {
    live.moving += 1
    void joined.then(() => {
      live.moving -= 1
    })
  }

  // Tasks from an earlier session: the status line says so, and the pane
  // opens where the terminal is wide enough to seat it unasked, unless the
  // session has ended since.
  const shown = joined
    .then(async () => {
      if ((await refresh($)) && live.ends === ends) {
        await show($, false)
      }

      // chat-sidecar: Elsewhere's count from the start.
      await scanElsewhere($, live.storeKeys)
    })
    .catch(() => undefined)

  // One that ended before this ran has no heartbeat: its end stopped the last.
  if (live.ends === ends) {
    live.heartbeat?.cancel()
    live.heartbeat = $.clock.every(HEARTBEAT_MS, () => void beat($))
  }

  // A store slow to answer holds up the start 5 seconds at most: what the
  // session takes on shows once it answers.
  await awaited($, joined)
  await redrawn($, shown)
}

/**
 * Takes on the tasks this session owns in the project's store: its own (a
 * resumed session) and those of sessions that ended or went quiet. A live
 * session's tasks stay its own: answers go to the session that asked. A hot
 * reload keeps the session's tasks as they are.
 */
async function load($: EngineInterface) {
  if (await isLoaded($)) {
    await sync($)
    return
  }

  const nowMs = await $.clock.now()
  const stored = await readProject($)
  const holder = await read($, loadedFor)
  const notes = await read($, took)
  const count = await read($, nextId)
  let project = stored
  let adoption!: Adoption
  // Tasks the process held that the join numbers anew.
  let moves: Move[] = []
  // Tasks the process didn't hold: their numbers may have named others here.
  let arrived: Task[] = []

  // Taken on against the task list as it stands when it changes hands, so a
  // press meanwhile is kept. `update` runs this again when another write
  // beat it: the last run is the list it wrote. The session's own tasks it
  // is done with, which no slot holds, stay in it, with the numbers its
  // Claude knows them by.
  await update($, tasks, current => {
    const done = current.filter(task => task.sessionId === live.sessionId && !isShown(task))
    project = withHeld(stored, holder, slotFrom(current, notes, count, nowMs), nowMs)
    adoption = adopt(project, live.sessionId, nowMs, done.map(task => task.id), live.endedMs !== undefined, holder)
    moves = adoption.renumbered.filter(({ task }) => current.some(one => isSameTask(one, task))).map(({ task, id }) => ({ from: task.id, to: id }))
    arrived = adoption.adopted.filter(task => !current.some(one => isSameTask(one, task)) && !moves.some(move => move.to === task.id))

    return [...done, ...adoption.adopted].sort((a, b) => a.id - b.id)
  })

  await renumber($, moves, arrived.map(task => task.id))
  live.readMs = nowMs
  live.hasSlot ||= live.sessionId in stored.slots
  await update($, nextId, n => Math.max(n, adoption.nextId))
  await update($, took, () => adoption.took)
  await update($, loadedFor, () => live.sessionId)
  live.elsewhere = elsewhereIn(project, live.sessionId, nowMs)
  live.floor = adoption.nextId
  live.hasLegacyPeer = hasLegacyPeer(project, live.sessionId, nowMs)

  try {
    // The slot first, noting what it took: only then do the slots it took from leave.
    await writeOwn($, adoption.removed.length > 0)
    await clean($, project, adoption.removed, adoption.legacy)
  } catch {
    // What it took on stands, and the caller shows it: the next heartbeat
    // makes the writes.
  }
}

/** A task the process held that the join numbered anew: the number it leaves, and the one it takes. */
type Move = { from: number; to: number }

/**
 * Has what the process keeps under task numbers follow its tasks through a
 * join. A task it held that the join numbered anew (`moves`) takes its
 * drafts, a field open on it, the ring and the selection along. Under the
 * numbers of tasks it didn't hold (`arrived`: another session drew the
 * number too, or a resumed one did), it lets go of the drafts, what was
 * typed as a task under it closed, and a field open on it. Kept, they would
 * go with the task that holds the number now.
 */
async function renumber($: EngineInterface, moves: readonly Move[], arrived: readonly number[]) {
  const toOf = (id: number) => moves.find(move => move.from === id)?.to

  for (const field of ['answer', 'reason'] as const) {
    // Carried first: the number a task leaves may be one another arrived under.
    for (const { from, to } of moves) {
      const draft = live.drafts.get(fieldKeyOf({ id: from, field }))

      if (draft !== undefined) {
        live.drafts.set(fieldKeyOf({ id: to, field }), draft)
      }

      if (live.ring === fieldKeyOf({ id: from, field })) {
        live.ring = fieldKeyOf({ id: to, field })
      }
    }

    for (const id of arrived) {
      live.drafts.delete(fieldKeyOf({ id, field }))
    }
  }

  for (const id of arrived) {
    live.closed.delete(fieldKeyOf({ id, field: 'answer' }))
  }

  await update($, editing, field => {
    if (field === null) {
      return null
    }

    const to = toOf(field.id)
    return to !== undefined ? { ...field, id: to } : arrived.includes(field.id) ? null : field
  })
}

/**
 * Whether the session has read the project as itself: until then, the store
 * may hold tasks of its own it hasn't taken on. `loadedFor` names the session
 * whose tasks the process holds.
 */
async function isLoaded($: EngineInterface): Promise<boolean> {
  return (await read($, loadedFor)) === live.sessionId
}

/**
 * The project as read, with what this process holds (`slot`) that the store
 * may not have. Held for another session (`holder`, the one it left at
 * /clear or a resume in place), it is that session's slot, ended: its end
 * write may have failed. The slot keeps the time the store has, so that it
 * leaves once this session's is written. Held for none (no session of the
 * process has read the project), it is the tasks its sessions assigned: each
 * session's beside the tasks the store holds for it, ended, unless it is this
 * one or the store doesn't show it ended. One alive or quiet there has been
 * resumed by another process since, or may have been: it keeps its slot, and
 * what it assigned here goes on in this one's.
 */
function withHeld(project: Project, holder: string | null, slot: Slot, nowMs: number): Project {
  if (holder !== null) {
    const stored = project.slots[holder]

    if (stored === undefined && slot.tasks.length === 0 && slot.took === undefined) {
      return project
    }

    return withSlots(project, { [holder]: { ...slot, seenMs: stored?.seenMs ?? 0, endedMs: nowMs } })
  }

  const own = live.sessionId
  const slots: Record<string, Slot> = {}

  for (const task of slot.tasks) {
    const stored = project.all[task.sessionId]
    const id = stored === undefined || stored.endedMs !== undefined ? task.sessionId : own
    const into = (slots[id] ??= { seenMs: 0, ...project.all[id], tasks: [], ...(id === own ? {} : { endedMs: nowMs }) })

    into.tasks.push(task)
  }

  for (const [id, held] of Object.entries(slots)) {
    held.tasks.push(...(project.all[id]?.tasks ?? []))
  }

  return withSlots(project, slots)
}

/**
 * Says this session is alive, and counts the tasks waiting in the project's
 * other sessions: `sync`, and a redraw of what it changed. Not `isWriting`
 * where a write follows (assigning). While store work given up on is still
 * out, it asks for no more: the first heartbeat after it settles syncs.
 */
async function beat($: EngineInterface, isWriting = true) {
  if (live.stalled > 0) {
    return
  }

  const was = live.elsewhere
  const synced = queued(() => sync($, isWriting)).catch((): Synced => 'same')
  const shown = synced
    .then(async outcome => {
      // A first read shows the project as joining does: the pane opens for
      // the tasks it took on.
      if ((outcome !== 'same' || live.elsewhere !== was) && (await refresh($)) && outcome === 'joined') {
        await show($, false)
      }

      // chat-sidecar: Elsewhere follows the other folders, folded too, for its count.
      await scanElsewhere($, live.storeKeys)
    })
    .catch(() => undefined)

  await awaited($, synced)
  await redrawn($, shown)
}

/**
 * Reads the project and acts on it: lets go of the tasks another session
 * took on while this one slept, keeps the notes of what this one took that
 * are still needed, counts the tasks waiting elsewhere, and writes the slot,
 * unless not `isWriting` (a write follows) and nothing leaves it or the
 * store: a task let go of leaves at once, since the caller may write nothing
 * after all (an ask that repeats one, say). A session that couldn't read the
 * project as it joined takes it on instead.
 * Resolves what changed of what it shows.
 */
async function sync($: EngineInterface, isWriting = true): Promise<Synced> {
  if (!(await isLoaded($))) {
    await load($)
    return 'joined'
  }

  const nowMs = await $.clock.now()
  const stored = await readProject($)
  const own = live.sessionId
  // With the session's own slot as it holds it: the store may not have its
  // last write, the note of tasks it took back among them.
  const project = withSlots(stored, { [own]: await slotOf($, nowMs) })
  const isLost = await letGo($, project)
  const pruned = prune(project, own, await read($, took), nowMs)

  await update($, took, () => pruned.took)
  live.readMs = nowMs
  live.hasSlot ||= own in stored.slots
  live.elsewhere = elsewhereIn(project, own, nowMs)
  live.floor = floorOf(project)
  live.hasLegacyPeer = hasLegacyPeer(project, own, nowMs)

  try {
    // The slot first: it carries the tasks let go of before the note that
    // told of them leaves, and the notes and count of a slot before it does.
    if (isWriting || isLost || pruned.removed.length > 0 || !isEmptyEdit(pruned.legacy)) {
      await writeOwn($, pruned.removed.length > 0)
    }

    await clean($, project, pruned.removed, pruned.legacy)
  } catch {
    // What it let go of stands, and the caller redraws it: the next
    // heartbeat makes the writes.
  }

  return isLost ? 'lost' : 'same'
}

/**
 * Lets go of the tasks another session took on while this one was quiet (a
 * laptop asleep, say): they are that session's now, and the user answers
 * them there. Resolves whether any of them was shown.
 */
async function letGo($: EngineInterface, project: Project): Promise<boolean> {
  const isTaken = (task: Task) => isTakenFrom(project, live.sessionId, task)
  const list = await read($, tasks)

  if (!list.some(isTaken)) {
    return false
  }

  const lost = list.filter(task => isTaken(task) && isShown(task))

  await update($, tasks, current => current.filter(task => !isTaken(task)))

  for (const task of lost) {
    await settle($, task.id)
  }

  if (lost.length > 0) {
    const which = numbersOf(lost.map(task => task.id))
    const [noun, them] = lost.length === 1 ? ['task', 'it'] : ['tasks', 'them']

    $.ui.toast(`Another session in this project took on ${noun} ${which} while this one was away. Answer ${them} there.`, {
      timeoutMs: 8000,
    })
  }

  return lost.length > 0
}

/**
 * Runs store work one piece at a time, in the order asked, so no write of
 * the session's lands after a newer one. No piece asks for another.
 */
function queued<T>(work: () => Promise<T>): Promise<T> {
  const done = live.queue.then(work, work)
  live.queue = done.catch(() => undefined)

  return done
}

/**
 * Resolves once store `work` settles, or `STORE_WAIT_MS` on: a press, a
 * prompt or a tool call goes on without a store that is slow to answer, and
 * the work finishes on its own, in its place in the queue. Until work given
 * up on settles, nothing waits on the store at all.
 */
async function awaited($: EngineInterface, work: Promise<unknown>) {
  if (live.stalled > 0) {
    return
  }

  if (!(await within($, work))) {
    const settled = () => {
      live.stalled -= 1
    }

    live.stalled += 1
    void work.then(settled, settled)
  }
}

/**
 * Resolves once the redraw that store work leads to settles, `STORE_WAIT_MS`
 * on, or at once while that work was given up on: it is no store work, so a
 * surface slow to open the pane holds up neither the store nor the heartbeat.
 */
async function redrawn($: EngineInterface, shown: Promise<unknown>) {
  if (live.stalled === 0) {
    await within($, shown)
  }
}

/** Resolves once `work` settles, or `STORE_WAIT_MS` on, whichever is first: whether it settled. */
function within($: EngineInterface, work: Promise<unknown>): Promise<boolean> {
  return new Promise(finish => {
    const timer = $.clock.after(STORE_WAIT_MS, () => finish(false))
    const done = () => {
      timer.cancel()
      finish(true)
    }

    void work.then(done, done)
  })
}

/**
 * Reads the project: 0.1.4's value, when there is one, and each session's
 * slot, one read of the store each. Joining, the heartbeat and assigning
 * read it; a pane press or a prompt, which a person waits on, doesn't.
 */
async function readProject($: EngineInterface): Promise<Project> {
  const keys = keysOf(live.root)
  const all = await $.store.keys()
  // chat-sidecar: kept for Elsewhere, which then reads only other folders' keys.
  live.storeKeys = all
  const wanted = all.filter(key => key === keys.legacy || key.startsWith(keys.prefix))
  const values = await Promise.all(wanted.map(key => $.store.get(key)))

  return projectOf(live.root, Object.fromEntries(wanted.map((key, i) => [key, values[i]])))
}

/**
 * Writes the session's slot from what it holds, under its own key: the one
 * key it writes. A session that never held a task has no slot, unless
 * `isForced`: its count must be in the store before a slot that carries one
 * leaves it. One that has a slot keeps it, its count in it, until it ends,
 * and the next session in the project removes it; it has one from the first
 * write it makes, landed or not, since a write that fails, the next one
 * makes, its tasks gone by then or not. A session that hasn't read the
 * project writes nothing: it would write over tasks of its own.
 */
async function writeOwn($: EngineInterface, isForced = false) {
  if (!(await isLoaded($))) {
    return
  }

  const nowMs = await $.clock.now()
  const slot = await slotOf($, nowMs)

  if (!live.hasSlot && !isForced && slot.tasks.length === 0 && slot.took === undefined) {
    return
  }

  live.hasSlot = true
  await $.store.set(keysOf(live.root).session(live.sessionId), slot)
  live.writtenMs = nowMs
}

/** The session's slot, from what it holds now. */
async function slotOf($: EngineInterface, nowMs: number): Promise<Slot> {
  return slotFrom(await read($, tasks), await read($, took), await read($, nextId), nowMs)
}

/** The session's slot, holding `list`, its `notes` of what it took, and its count. */
function slotFrom(list: readonly Task[], notes: Readonly<Record<string, Took>>, count: number, nowMs: number): Slot {
  return {
    tasks: list.filter(isShown),
    seenMs: nowMs,
    nextId: count,
    ...(Object.keys(notes).length > 0 ? { took: { ...notes } } : {}),
    ...(live.endedMs === undefined ? {} : { endedMs: live.endedMs }),
  }
}

/**
 * Removes the slots this session took over and no longer needs, once its own
 * is written: each of this version's unless it changed since it was read (its
 * session came back), and 0.1.4's by `legacyEdit`.
 */
async function clean($: EngineInterface, project: Project, removed: readonly string[], legacyEdit: LegacyEdit) {
  const keys = keysOf(live.root)

  for (const id of removed) {
    const key = keys.session(id)
    const current = await $.store.get(key)

    if (isSlot(current) && current.seenMs === project.slots[id]?.seenMs) {
      await $.store.delete(key)
    }
  }

  await editLegacy($, legacyEdit, project.legacy.nextId)
}

/**
 * Applies `legacyEdit` to 0.1.4's value as it stands just before, its count
 * raised to this session's; with nothing else to change, raises the count
 * alone, while a 0.1.4 session alive here numbers its tasks from it, and only
 * past the count as it was just read (`readCount`). A 0.1.4 session writing
 * in between is the race 0.1.4 always had among its own. A session that
 * hasn't read the project changes nothing there.
 */
async function editLegacy($: EngineInterface, legacyEdit: LegacyEdit, readCount = 0) {
  const key = keysOf(live.root).legacy
  const count = await read($, nextId)

  if (key === undefined || !(await isLoaded($)) || (isEmptyEdit(legacyEdit) && (!live.hasLegacyPeer || count <= readCount))) {
    return
  }

  const current = legacyOf(await $.store.get(key))
  const edited = editedLegacy(current, legacyEdit, count, await $.clock.now())

  if (!isEmptyEdit(legacyEdit) || edited.nextId > current.nextId) {
    await $.store.set(key, edited)
  }
}

/**
 * Before a person's press or prompt acts on the tasks: when the slot is two
 * heartbeats old, the session may have slept long enough for another to take
 * its tasks on, so it reads the project, lets them go and redraws. Otherwise
 * it reads nothing: a person waits on this.
 */
async function wake($: EngineInterface) {
  if (live.hasSlot && (await $.clock.now()) - Math.max(live.writtenMs, live.readMs) >= 2 * HEARTBEAT_MS) {
    await beat($)
  }
}

/**
 * Changes the task list and, when that changes it (`fn` hands back a new
 * list), writes the slot, reading nothing (see `wake`). The session's own
 * state is what counts: a write that fails now, the heartbeat makes.
 */
async function change($: EngineInterface, fn: (list: readonly Task[]) => readonly Task[]) {
  await wake($)
  let isChanged = false

  // `update` runs `fn` again when another write beat it: the last run counts.
  await update($, tasks, list => {
    const changed = fn(list)
    isChanged = changed !== list
    return changed
  })

  if (isChanged) {
    await awaited($, queued(() => writeOwn($)))
    await refresh($)
  }
}

/**
 * Marks the updates Claude has not heard delivered (every one, or those
 * `isWanted`), in one change of the task list, and resolves them: the path
 * that claims them sends them, and no other finds them waiting meanwhile.
 */
async function claim($: EngineInterface, isWanted: (task: Task) => boolean = () => true): Promise<readonly Task[]> {
  const isDue = (task: Task) => task.update === 'pending' && isWanted(task)
  let due: readonly Task[] = []

  if (!(await read($, tasks)).some(isDue)) {
    return due
  }

  await change($, list => {
    due = list.filter(isDue)

    return list.map(task => (isDue(task) ? { ...task, update: 'delivered' } : task))
  })

  return due
}

/** Keeps the status line in step with the tasks. Resolves whether anything is shown. */
async function refresh($: EngineInterface): Promise<boolean> {
  const shown = (await read($, tasks)).filter(isShown)

  $.ui.status(statusOf(shown, live.elsewhere))

  return shown.length > 0
}

/**
 * Brings up Tasks for me in the sidecar; `isAsked` when the person asked (/my-tasks, the band), so it takes the keys,
 * its ring on the open field, else on the first task's first button. Resolves whether the sidecar is drawn.
 */
async function show($: EngineInterface, isAsked: boolean): Promise<boolean> {
  const placed = await sidecarShowTasks($, isAsked).catch(() => false)

  if (placed && isAsked) {
    const key = await ringOf($)

    if (key !== undefined) {
      void $.ui.focus({ requestId: SIDECAR, key }).then(undefined, () => undefined)
    }
  }

  return placed
}

/** Where the ring goes as Tasks for me is brought up: the open field, Edit on an answer held back, or the first button. */
async function ringOf($: EngineInterface): Promise<string | undefined> {
  const field = await read($, editing)

  if (field !== null) {
    return field.held !== undefined ? 't-edit' : fieldKeyOf(field)
  }

  const first = (await read($, tasks)).find(isActive)

  return first === undefined ? undefined : actionKeyOf(first, actionsFor(first, true)[0]!.key)
}

/** What the pane draws from: the session's state, and what only the surface knows. */
async function paneView($: EngineInterface, surface: Pick<PaneView, 'canType' | 'isFocused'>): Promise<PaneView> {
  const field = await read($, editing)
  const key = openKeyOf(field)
  const state = {
    shown: (await read($, tasks)).filter(isShown),
    editing: field,
    draft: key === undefined ? '' : (live.drafts.get(key) ?? ''),
    nowMs: await $.clock.now(),
    sessionId: await $.session.id(),
    isWorking: await read($, isWorking),
  }

  return seated(state, surface)
}

/** The pane's `view` as a surface that `canType`, and holds the keys or not, draws it. */
function seated(view: Omit<PaneView, 'canType' | 'isFocused'>, surface: Pick<PaneView, 'canType' | 'isFocused'>): PaneView {
  return { ...view, canType: surface.canType, isFocused: surface.isFocused }
}

/** The key of the field open to type in, unless an answer held there for looking like a secret takes its place. */
function openKeyOf(field: Editing | null): string | undefined {
  return field === null || field.held !== undefined ? undefined : fieldKeyOf(field)
}

/** Keeps what the user typed in the field keyed `key`. */
function typed(key: string, value: string) {
  // Keys typed in a field say the ring is on it, though no move said so.
  live.ring = key
  live.drafts.set(key, value)
}

/** What `surface` draws the field keyed `key` with: its draft, as the surface first drew it (see `live.drawn`). */
function fieldValueOf(surface: RenderSurface, key: string): string {
  const drawn = live.drawn.get(surface) ?? new Map<string, string>()
  const value = drawn.get(key) ?? live.drafts.get(key) ?? ''

  live.drawn.set(surface, drawn.set(key, value))
  return value
}

/**
 * Changes task `id` with `fn` while it is open, and resolves the task as the
 * change found it: one closed meanwhile (Claude withdrew it, or a press from
 * an older render answered it) or gone (another session took it on) stays
 * as it is.
 */
async function edit($: EngineInterface, id: number, fn: (task: Task) => Task): Promise<Task | undefined> {
  const nowMs = await $.clock.now()
  let found: Task | undefined

  await change($, list => {
    found = list.find(task => task.id === id)

    return found !== undefined && isActive(found) ? list.map(task => (task.id === id ? { ...fn(task), updatedMs: nowMs } : task)) : list
  })

  return found
}

/**
 * Passes on a prompt that carries `due` to Claude, where `isCarried` looks
 * for each; the caller claimed them, so no other path sends them meanwhile.
 * Those that don't enter with it (a hook beneath dropped it or took them
 * out, or it failed) wait again for the next send, and a toast says so, as
 * `onDrop` says for a drop.
 */
async function passOn<R extends PromptSubmitResult>(
  $: EngineInterface,
  due: readonly Task[],
  isCarried: (entered: Entered, task: Task) => boolean,
  onDrop: DropNote,
  pass: () => Promise<R>,
): Promise<R> {
  let back: { lost: readonly Task[]; note: DropNote; reason?: string } | undefined

  try {
    const result = await pass()

    if (result.drop !== undefined) {
      back = { lost: due, note: onDrop, reason: result.drop }
    } else {
      const lost = due.filter(task => !isCarried(result, task))

      if (lost.length > 0) {
        // The prompt entered, and Claude takes a turn on it: sent again as
        // that turn ends, a response a hook beneath always takes out (or
        // rewords at its head) would go round and round. It waits for Send
        // now, as the toast says, or the next prompt.
        lost.forEach(task => live.held.add(updateKeyOf(task)))
        await update($, heldKeys, () => [...live.held])
        back = { lost, note: 'why', reason: 'a hook took it out of the prompt' }
      }
    }

    return result
  } catch (error) {
    back = { lost: due, note: 'why', reason: error instanceof Error ? error.message : String(error) }

    throw error
  } finally {
    if (back !== undefined) {
      await giveBack($, back.lost.map(task => task.id), back.note, back.reason)
    }
  }
}

/**
 * Whether a prompt that entered carries an update in its words, by how the
 * update opens there (`#5 <title>:`): a hook beneath may rewrite what an
 * answer says (mask a secret in it, say); one that takes the update out, or
 * rewords its head, leaves it to send again, since Claude hearing it twice
 * beats not hearing it.
 */
function inWords(entered: Entered, task: Task): boolean {
  return entered.text.includes(ownHeadOf(task))
}

/** The update a task carries, the same through each send and give-back: a new one changes `updatedMs`. */
function updateKeyOf(task: Task): string {
  return `${task.id}@${task.updatedMs}`
}

/** Whether a prompt that entered carries an update in a digest beside its words (`#5 done: <title>.`), read as `inWords` reads them. */
function inDigest(entered: Entered, task: Task): boolean {
  return (entered.context ?? []).some(block => block.includes(newsHeadOf(task)))
}

/**
 * Gives back updates that never reached Claude, to go with the next send,
 * and says so as `note` says. It never throws: `passOn` keeps the prompt's
 * own error.
 */
async function giveBack($: EngineInterface, ids: readonly number[], note: DropNote, reason?: string) {
  try {
    await undelivered($, ids)
  } catch {
    // `change` sets the session's state before the store and lets a store
    // write fail quietly; nothing else here is expected to throw.
  }

  if (note === 'nothing') {
    return
  }

  const which = numbersOf(ids)
  const why = note === 'why' && reason !== undefined ? `: ${printable(reason, 200).replace(/[.!]+$/, '')}` : ''

  $.ui.toast(`Claude didn't get your response to ${which}${why}. It's saved; press Send now in Tasks for me (/my-tasks).`, {
    timeoutMs: 8000,
  })
}

/** Gives back updates marked delivered that never reached Claude: they wait again. */
async function undelivered($: EngineInterface, ids: readonly number[]) {
  await change($, list => list.map(task => (ids.includes(task.id) && task.update === 'delivered' ? { ...task, update: 'pending' } : task)))
}

/**
 * Drops a field whose task is
 * gone, keeping what was typed for its answer for a press from a drawing
 * from before.
 */
async function settle($: EngineInterface, id: number) {
  const key = fieldKeyOf({ id, field: 'answer' })
  const draft = live.drafts.get(key)

  if (draft !== undefined) {
    live.closed.set(key, draft)
  }

  for (const field of ['answer', 'reason'] as const) {
    forget(fieldKeyOf({ id, field }))
    live.drafts.delete(fieldKeyOf({ id, field }))
  }

  await update($, editing, field => (field?.id === id ? null : field))
}

/**
 * The user fulfilled or rejected a task; `how` says when Claude hears of it.
 * Resolves the task as it stood, as `edit` does: one no longer open stays as it is.
 */
async function resolve($: EngineInterface, id: number, patch: Pick<Task, 'state'> & Partial<Task>, how: How) {
  const was = await edit($, id, task => ({ ...task, ...patch, update: 'pending' }))
  const isOpen = was !== undefined && isActive(was)
  await settle($, id)

  // One no longer open sends nothing new, and holds back no batch under way;
  // Send now still sends the answer it repeats, saved for later.
  if ((how === 'now' && (isOpen || isRepeatOf(was, patch))) || (how === 'auto' && isOpen && !working())) {
    sendSoon($)
  }

  return was
}

/** Whether task `was` stands answered as `patch` would answer it: a second press, say. */
function isRepeatOf(was: Task | undefined, patch: Pick<Task, 'state'> & Partial<Task>): boolean {
  return was !== undefined && was.state === patch.state && was.answer === patch.answer && was.reason === patch.reason
}

/**
 * A press on the pane resolves task `id`, as `resolve` does. One Claude
 * withdrew, another session took on, or the user answered otherwise (on
 * another surface, say) since the pane drew it says so, and what the user
 * typed for it (`typedText`) goes to the prompt box, unless it looks like a
 * secret; one already answered as this press would answer it (a second
 * press) stays answered.
 */
async function respond($: EngineInterface, id: number, patch: Pick<Task, 'state'> & Partial<Task>, how: How, typedText = '') {
  const was = await resolve($, id, patch, how)

  if (was === undefined || (!isActive(was) && !isRepeatOf(was, patch))) {
    const kept = (await toPromptBox($, typedText)) ? ' What you typed is in the prompt box.' : ''

    $.ui.toast(`Task #${id} isn't open any more, so your response wasn't saved.${kept}`, { timeoutMs: 8000 })
  }
}

/**
 * Puts what was typed for a task that closed in the prompt box, on a line
 * after any draft there, unless it looks like a secret; resolves whether the
 * box took it.
 */
async function toPromptBox($: EngineInterface, text: string): Promise<boolean> {
  if (text === '' || looksSecret(text)) {
    return false
  }

  const box = await $.prompt.read()
  const filled = await $.prompt.fill({ text: box.text === '' ? text : `\n${text}`, mode: 'append' }).catch(() => ({ isFilled: false }))

  return filled.isFilled
}

/**
 * Answers task `id` with what is typed in its field, or, pressed on a
 * drawing from before the task closed, with what was typed before it did.
 */
async function answerTyped($: EngineInterface, id: number, how: How) {
  const key = fieldKeyOf({ id, field: 'answer' })

  return answer($, id, live.drafts.get(key) ?? live.closed.get(key) ?? '', how)
}

/** Whether task `id` is open now: one closed meanwhile, or gone, takes no answer. */
async function isOpenNow($: EngineInterface, id: number): Promise<boolean> {
  return (await read($, tasks)).some(task => task.id === id && isActive(task))
}

async function answer($: EngineInterface, id: number, text: string, how: How, isSecretOk = false) {
  const value = text.trim()
  // Entered or pressed on a drawing from before its task closed, an answer
  // goes to `respond`, which says the task isn't open any more.
  const isOpen = await isOpenNow($, id)

  if (isOpen && value === '') {
    $.ui.toast('Type an answer first, or press Cancel.')
    return
  }

  if (isOpen && !isSecretOk && looksSecret(value)) {
    await update($, editing, (): Editing => ({ id, field: 'answer', held: value }))
    return
  }

  await respond($, id, { state: 'done', answer: value }, how, value)
}

async function startEditing($: EngineInterface, id: number, field: Editing['field']) {
  // Pressed on a drawing from before its task closed, it leaves the pane as it is.
  if (!(await isOpenNow($, id))) {
    return
  }

  const key = fieldKeyOf({ id, field })

  forget(key)
  // The field takes the ring as it opens: by the move below, or by its
  // autoFocus, whose `ui.focus` reaches none of this plugin's hooks.
  live.ring = key
  await update($, editing, (): Editing => ({ id, field }))

  // A field the sidecar can't focus (it doesn't hold the keyboard) is still a click away.
  void $.ui.focus({ requestId: SIDECAR, key }).then(undefined, () => undefined)
}

/** Has every surface draw the field keyed `key` afresh, with its draft. */
function forget(key: string) {
  for (const drawn of live.drawn.values()) {
    drawn.delete(key)
  }
}

async function stopEditing($: EngineInterface) {
  await update($, editing, () => null)
}

/** Moves a long answer into the prompt box, where the real editor takes pastes and lines. */
async function longAnswer($: EngineInterface, id: number) {
  // Pressed on a drawing from before its task closed, it answers as Save for
  // later would: the task isn't open any more.
  if (!(await isOpenNow($, id))) {
    return answerTyped($, id, 'later')
  }

  const key = fieldKeyOf({ id, field: 'answer' })
  const box = await $.prompt.read()
  const draft = live.drafts.get(key) ?? ''
  const text = bridgeOf(id) + [draft, box.text].filter(part => part.trim() !== '').join('\n')
  const filled = await $.prompt.fill({ text, mode: 'replace' })

  if (!filled.isFilled) {
    $.ui.toast("Couldn't open the prompt box for your answer; type it here instead.")
    return
  }

  live.drafts.delete(key)
  await update($, editing, () => null)
  $.ui.toast('Write your answer in the prompt box (Esc gets you there), then press Enter.', {
    timeoutMs: 8000,
  })
}

function sendNow($: EngineInterface) {
  live.batch?.cancel()
  live.batch = null
  void send($)
}

function sendSoon($: EngineInterface) {
  live.batch?.cancel()
  live.batch = $.clock.after(BATCH_MS, () => {
    live.batch = null
    void send($)
  })
}

/**
 * Hands Claude every update it has not heard: a turn of its own while it is
 * idle, a row its running turn reads at the next step while it works.
 * `isTurnOver`: sent as main's turn ends, when Claude is idle whatever the
 * engine's last word on it was.
 */
async function send($: EngineInterface, isTurnOver = false) {
  // What the process holds is the folder's it leaves: its Claude hears it there.
  if (live.moving > 0) {
    return
  }

  await wake($)
  const due = await claim($)

  if (due.length === 0) {
    return
  }

  const text = messageOf(due)
  const ids = due.map(task => task.id)
  const which = numbersOf(ids)

  if (isTurnOver || !working()) {
    await passOn($, due, inWords, 'why', () => $.prompt.submit({ text, asUser: true })).catch(() => undefined)
    return
  }

  const isTaken = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).then(
    appended => appended.deny === undefined,
    () => false,
  )

  if (!isTaken) {
    await undelivered($, ids)

    // The turn ended while the row was being refused: they go now.
    if (!working()) {
      void send($, true)
      return
    }

    live.isSendingAtEnd = true
    $.ui.toast(`Claude gets your response to ${which} when it finishes this turn.`)
    return
  }

  live.isUnread = true

  try {
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: `Sent your response to ${which} to Claude` }] } })
  } catch {
    // The notice is for the user's eyes only; Claude has the answer either way.
  }
}
