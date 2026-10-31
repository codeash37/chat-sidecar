// chat-sidecar 0.5.0: the main module. The Sidecar pane (frame, settings, To-do, Subagents, Background, Connectors,
// Context files, Skills, Git, and Tasks for me through hooks/tasks), the plan band above the prompt and the plan tool.
// Written from SPEC.md.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderSurface, Timer } from 'claude-code'

import type { BandState, Card, CardsView, ConnectorCall, GitInfo, Inventory, Listener, Plan, SettingsScreen, Step, StepKind, Task } from '../types'
import { BAND_COLOR_IDS, BAND_COLOR_NAMES, PALETTES, bandCounts, bandSvg, bandWidthPx } from './band'
import type { BandColor } from './band'
import { BAR_STYLE_IDS, BAR_STYLE_NAMES, agentParts, planCells } from './barstyle'
import type { BarStyle, Cell } from './barstyle'
import { poll } from './background'
import { cut, isCountedServer, mcpCallText, mcpSummary, parseCli, rowKey, serverName, splitMcp } from './connectors'
import { readGit } from './git'
import {
  CARD_COLORS,
  CARD_HEX,
  EMPTY_INVENTORY,
  EMPTY_PLAN,
  FILES_STEP,
  FILES_WINDOW,
  KIND_NAMES,
  addConnectorCall,
  addFile,
  addMemoryFiles,
  addSkill,
  applyPlanTool,
  applyTaskCreate,
  applyTaskUpdate,
  applyTodoWrite,
  badPorts,
  bandNote,
  bareImage,
  clampTop,
  clockOf,
  connectorsShown,
  createdId,
  elapsed,
  fileName,
  filesShown,
  homeShort,
  isAllDone,
  isSpill,
  modelShort,
  nextBand,
  normPath,
  pickColor,
  planDone,
  plural,
  portGroups,
  pruneCards,
  shownFolder,
  skillOfPath,
  skillsShown,
  stepOf,
  switchesOf,
  tokens,
  transcriptPath,
  transcriptTimes,
  usageTotal,
  withStep,
  wrap,
} from './helpers'
import { DEFAULT_ORDER, DEFAULT_PORTS, SECTION_IDS, SHOW_FIELD, ago, level, settings } from './parse'
import type { SectionId, Settings } from './parse'
import {
  registerTasks,
  tasksBeforeOpen,
  tasksOnAbovePrompt,
  tasksOnSessionStart,
  tasksOnTurnComplete,
  tasksOnTurnStep,
  tasksSection,
  tasksShow,
  tasksUndrawn,
} from './tasks/register'
import { isShown } from './tasks/tasks'
import { LOGOS } from './logos'

// ---- Constants ----

const PLUGIN = 'chat-sidecar'
const PANE_ID = 'chat-sidecar'
const PANE_TITLE = 'Sidecar'
const PLAN_TOOL = 'mcp__chat-sidecar__plan'
const ACCENT = 'claude'
const ACCENT_HEX = '#d97757'

const TITLES: Record<SectionId, string> = {
  todo: 'To-do',
  tasks: 'Tasks for me',
  subagents: 'Subagents',
  background: 'Background',
  connectors: 'Connectors',
  files: 'Context files',
  skills: 'Skills',
  git: 'Git',
}

const TEXT = {
  off: 'Chat sidecar is off: remove "chat-sidecar": false from ~/.claude/mods/switches.json.',
  offLine: 'Turned off in ~/.claude/mods/switches.json ("chat-sidecar": false).',
  opened: 'Opened the Sidecar pane.',
  openedSettings: 'Opened the chat sidecar settings.',
  hidden: 'Chat sidecar hidden. Type /chat-sidecar to show it again.',
  allOff: 'All sections are off. Open ⚙ Settings to turn one on.',
  noPlan: 'No to-do list yet. Claude makes one for any task with 1 or more steps.',
  noneUsed: 'None used yet',
  noAgents: 'None yet. Cards show up when Claude starts a subagent.',
  nothingBg: 'Nothing running in the background.',
  planSaved: 'Plan saved. Send the whole list again on every change.',
  planSubagent: 'Only the main chat keeps a plan. Carry on with your task.',
  planOff: 'The chat sidecar is off, so the plan is not shown.',
  planError: 'Plan not saved: something went wrong in the chat sidecar.',
}

const PLAN_SPEC = {
  name: 'plan',
  description:
    'Save the plan for the job in front of you: the steps in order, each pending, in_progress or completed. It draws the to-do list and a progress bar above the prompt for the user. Send the whole list on every change. Main chat only: a subagent does not call it.',
  isDeferred: false as const,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A short name for the job, a few words.' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
          required: ['text', 'status'],
        },
      },
    },
    required: ['steps'],
  },
}

const KIND_COLORS: Record<StepKind, string> = {
  read: '#3e9bd6',
  write: ACCENT,
  command: '#c9a227',
  web: '#12a594',
  skill: '#8e4ec6',
  subagent: '#d6409f',
  connector: '#30a46c',
  tool: '#8a8a8a',
}

const MAX_ROWS = 40
const BAND_HIDE_MS = 20_000
const SWITCH_MS = 3000
const GIT_MS = 60_000
const CARD_TICK_MS = 300
const CARD_POLL_MS = 2000
const SHIMMER_MS = 350
const LOG_LINES = 200

// ---- State (atoms are declared here, in this file, as the engine requires) ----

const tasksAtom = atom({ plugin: 'chat-sidecar', key: 'tasks' } as const, [] as readonly Task[])
const listenersAtom = atom({ plugin: 'chat-sidecar', key: 'listeners' } as const, [] as Listener[], { shape: 'v3' })
const gitAtom = atom({ plugin: 'chat-sidecar', key: 'git' } as const, null as GitInfo | null)
const bgOpenAtom = atom({ plugin: 'chat-sidecar', key: 'bgOpen' } as const, null as number | null)
const bgHideIdleAtom = atom({ plugin: 'chat-sidecar', key: 'bgHideIdle' } as const, false)
const offAtom = atom({ plugin: 'chat-sidecar', key: 'off' } as const, false)
const hiddenAtom = atom({ plugin: 'chat-sidecar', key: 'hidden' } as const, false)
const foldedAtom = atom({ plugin: 'chat-sidecar', key: 'folded' } as const, [] as readonly string[])
const screenAtom = atom({ plugin: 'chat-sidecar', key: 'settings' } as const, { open: false, portsError: null, portsDraft: null } as SettingsScreen)
const autoOpenedAtom = atom({ plugin: 'chat-sidecar', key: 'autoOpened' } as const, false)
const seededAtom = atom({ plugin: 'chat-sidecar', key: 'seededFor' } as const, null as string | null)
const planAtom = atom({ plugin: 'chat-sidecar', key: 'plan' } as const, EMPTY_PLAN)
const bandAtom = atom({ plugin: 'chat-sidecar', key: 'band' } as const, { shown: false, allDone: false, stamp: 0 } as BandState)
const inventoryAtom = atom({ plugin: 'chat-sidecar', key: 'inventory' } as const, EMPTY_INVENTORY)
const openConnectorAtom = atom({ plugin: 'chat-sidecar', key: 'openConnector' } as const, null as string | null)
const filesTopAtom = atom({ plugin: 'chat-sidecar', key: 'filesTop' } as const, 0)
const cardsAtom = atom({ plugin: 'chat-sidecar', key: 'cards' } as const, [] as readonly Card[])
const cardsViewAtom = atom({ plugin: 'chat-sidecar', key: 'cardsView' } as const, { expanded: [], folded: [] } as CardsView)
const clockAtom = atom({ plugin: 'chat-sidecar', key: 'clock' } as const, 0)
const shimmerAtom = atom({ plugin: 'chat-sidecar', key: 'shimmer' } as const, 0)

// ---- Module memory (a reload starts it over; session.start rebuilds it) ----

const live = {
  cfg: settings({}) as Settings,
  /** The `ports` option as the module received it (undefined: no value). */
  rawPorts: undefined as string | undefined,
  home: '',
  windows: false,
  cwd: '',
  off: false,
  hidden: false,
  switchTimer: null as Timer | null,
  bgTimer: null as Timer | null,
  gitTimer: null as Timer | null,
  cardTick: null as Timer | null,
  cardPoll: null as Timer | null,
  shimmer: null as Timer | null,
  bandHide: null as Timer | null,
  /** The plan stamp the band last saw. */
  bandStamp: -1,
  /** Tool-use ids already counted. */
  counted: new Set<string>(),
  /** Connector names learned for random-id servers. */
  serverNames: new Map<string, string>(),
  /** Agent ids not in `$.agent.list()` (the engine's own forks): ignored. */
  foreign: new Set<string>(),
  seat: 0,
  lastColor: -1,
  /** Skill names from the session's usage breakdown; null until read. */
  skills: null as Set<string> | null,
  /** The error log's writes, one after another. */
  logChain: Promise.resolve() as Promise<unknown>,
}

// ---- Small engine helpers ----

type Els = ReturnType<EngineInterface['ui']['resolve']>
type Input = Readonly<Record<string, unknown>>

const isShownSection = (id: SectionId) => live.cfg.sections.shown[id]

function logPath(): string {
  return `${live.home}/.claude/mods-logs/chat-sidecar.log`
}

function switchesPath(): string {
  return `${live.home}/.claude/mods/switches.json`
}

/** An error to the mod's log (last 200 lines); never thrown, never shown. */
function logError($: EngineInterface, place: string, err: unknown) {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  live.logChain = live.logChain
    .then(async () => {
      const now = new Date().toISOString()
      let old = ''
      try {
        if (await $.fs.exists(logPath())) old = await $.fs.read(logPath())
      } catch {
        old = ''
      }
      const lines = [...old.split('\n').filter(Boolean), `${now} ${place}: ${text.replace(/\s+/g, ' ')}`].slice(-LOG_LINES)
      await $.fs.write(logPath(), `${lines.join('\n')}\n`)
    })
    .catch(() => undefined)
}

function debugLog($: EngineInterface, text: string) {
  try {
    $.ui.log(text, { to: 'debug' })
  } catch {
    // no log
  }
}

function invalidate($: EngineInterface) {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // the surface draws again on its own
  }
}

/** An env value, empty or failing read as unset. */
async function envOf(pending: Promise<string | undefined>): Promise<string | undefined> {
  try {
    const v = await pending
    return v === undefined || v === '' ? undefined : v
  } catch {
    return undefined
  }
}

/** Whether two values differ as JSON (a write is skipped when they do not). */
function differs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b)
}

const inputOf = (e: object): Input => e as Input

// ---- switches.json ----

/** switches.json as an object: missing is `{}`, unreadable or invalid JSON is null. */
async function readSwitchFile($: EngineInterface): Promise<Record<string, unknown> | null> {
  try {
    if (!(await $.fs.exists(switchesPath()))) return {}
    const raw: unknown = JSON.parse(await $.fs.read(switchesPath()))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  } catch {
    return null
  }
}

async function writeSwitchFile($: EngineInterface, value: Record<string, unknown>) {
  try {
    await $.fs.write(switchesPath(), `${JSON.stringify(value, null, 2)}\n`)
  } catch (err) {
    logError($, 'switches', err)
  }
}

/** Reads the switches and applies a change: hidden closes the pane, off clears Background and Git. */
async function checkSwitches($: EngineInterface) {
  const file = await readSwitchFile($)
  if (file === null) return
  const { off, hidden } = switchesOf(file)
  const wasOff = live.off
  const wasHidden = live.hidden
  live.off = off
  live.hidden = hidden
  if (hidden && !wasHidden) await $.ui.close({ id: PANE_ID }).catch(() => undefined)
  if (off !== (await read($, offAtom))) await update($, offAtom, () => off)
  if (hidden !== (await read($, hiddenAtom))) await update($, hiddenAtom, () => hidden)
  if (off && !wasOff) {
    if ((await read($, listenersAtom)).length > 0) await update($, listenersAtom, () => [])
    if ((await read($, gitAtom)) !== null) await update($, gitAtom, () => null)
  }
  if (off !== wasOff) invalidate($)
  syncShimmer($)
  syncCardTimers($)
}

/** Clears the hidden key in switches.json and the flag. */
async function unhide($: EngineInterface) {
  const file = (await readSwitchFile($)) ?? {}
  if ('chat-sidecar:hidden' in file) {
    const { ['chat-sidecar:hidden']: _gone, ...rest } = file
    await writeSwitchFile($, rest)
  }
  live.hidden = false
  if (await read($, hiddenAtom)) await update($, hiddenAtom, () => false)
}

// ---- Opening the pane ----

async function openPane($: EngineInterface, focus: boolean): Promise<boolean> {
  try {
    await tasksBeforeOpen($)
  } catch (err) {
    logError($, 'tasks before open', err)
  }
  const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE, ...(focus ? { focus: true as const } : {}) })
  return opened.isPlaced
}

/**
 * Brings up Tasks for me (used by the task part's /my-tasks, a newly assigned task, and the band's count). A plain
 * function declaration: the task part imports it, and `$` is passed only to declarations.
 */
export async function sidecarShowTasks($: EngineInterface, isAsked: boolean): Promise<boolean> {
  if (live.off) return false
  if (live.hidden && !isAsked) return false
  if (live.hidden) await unhide($)
  const screen = await read($, screenAtom)
  if (screen.open) await update($, screenAtom, s => ({ ...s, open: false }))
  const folded = await read($, foldedAtom)
  if (folded.includes('tasks')) await update($, foldedAtom, f => f.filter(id => id !== 'tasks'))
  return openPane($, isAsked)
}

async function hidePane($: EngineInterface) {
  const file = await readSwitchFile($)
  if (file === null) logError($, 'hide', new Error('switches.json is not valid JSON; the hidden flag was not written'))
  else await writeSwitchFile($, { ...file, 'chat-sidecar:hidden': true })
  live.hidden = true
  if (!(await read($, hiddenAtom))) await update($, hiddenAtom, () => true)
  await $.ui.close({ id: PANE_ID }).catch(() => undefined)
  try {
    $.ui.toast(TEXT.hidden)
  } catch {
    // no toast
  }
  syncShimmer($)
}

// ---- The plan ----

async function changePlan($: EngineInterface, change: (plan: Plan) => Plan | null) {
  const now = await $.clock.now()
  let changed = false
  const plan = await update($, planAtom, old => {
    const next = change(old)
    if (next === null) return old
    changed = true
    return { ...next, stamp: Math.max(old.stamp + 1, now) }
  })
  if (changed) await planChanged($, plan)
}

/** The band follows a new plan stamp. */
async function planChanged($: EngineInterface, plan: Plan) {
  if (plan.stamp === live.bandStamp) return
  live.bandStamp = plan.stamp
  const { band, timer } = nextBand(await read($, bandAtom), plan)
  if (differs(await read($, bandAtom), band)) await update($, bandAtom, () => band)
  if (timer === 'cancel') cancelBandHide()
  if (timer === 'start') startBandHide($, plan.stamp)
  syncShimmer($)
}

function cancelBandHide() {
  live.bandHide?.cancel()
  live.bandHide = null
}

function startBandHide($: EngineInterface, stamp: number) {
  cancelBandHide()
  live.bandHide = $.clock.after(BAND_HIDE_MS, () => {
    live.bandHide = null
    void update($, bandAtom, b => (b.stamp === stamp ? { ...b, shown: false } : b))
      .then(() => syncShimmer($))
      .catch(err => logError($, 'band', err))
  })
}

async function dismissBand($: EngineInterface) {
  cancelBandHide()
  await update($, bandAtom, b => ({ ...b, shown: false }))
  syncShimmer($)
}

/** The shimmer clock runs only while the plan part shows a step in progress. */
function syncShimmer($: EngineInterface) {
  void (async () => {
    const plan = await read($, planAtom)
    const band = await read($, bandAtom)
    const want = !live.off && !live.hidden && isShownSection('todo') && band.shown && plan.steps.some(s => s.status === 'in_progress')
    if (want && !live.shimmer) live.shimmer = $.clock.every(SHIMMER_MS, () => void update($, shimmerAtom, t => (t + 1) % 1_000_000).catch(() => undefined))
    if (!want && live.shimmer) {
      live.shimmer.cancel()
      live.shimmer = null
    }
  })().catch(err => logError($, 'shimmer', err))
}

/** A main-chat built-in call that changes the plan. */
async function planFromBuiltin($: EngineInterface, tool: string, input: Input, result: unknown) {
  if (tool === 'TodoWrite') await changePlan($, p => applyTodoWrite(p, input))
  else if (tool === 'TaskCreate') await changePlan($, p => applyTaskCreate(p, input, createdId(result)))
  else if (tool === 'TaskUpdate') await changePlan($, p => applyTaskUpdate(p, input))
}

// ---- Inventory ----

/** A tool use counted into connectors, files and skills (once per tool-use id). */
function countUse(inv: Inventory, tool: string, input: Input, at: number | null): Inventory {
  let out = inv
  const mcp = splitMcp(tool)
  if (mcp) {
    if (!isCountedServer(mcp.server)) return out
    const name = serverName(mcp.server, mcp.tool, live.serverNames)
    const call: ConnectorCall = { text: mcpCallText(mcp.tool, name), summary: mcpSummary(input), at, cli: false }
    return addConnectorCall(out, rowKey(name), name, call)
  }
  if (tool === 'Bash' && typeof input.command === 'string') {
    for (const c of parseCli(input.command)) out = addConnectorCall(out, rowKey(c.name), c.name, { text: c.text, summary: c.summary, at, cli: true })
    return out
  }
  if (tool === 'Read' && typeof input.file_path === 'string') {
    const path = normPath(input.file_path)
    const skill = skillOfPath(path)
    if (skill !== undefined) return addSkill(out, skill)
    if (isSpill(path, live.home)) return out
    return addFile(out, path)
  }
  if (tool === 'Skill' && typeof input.skill === 'string') {
    const name = input.skill.replace(/^\//, '').trim()
    return name ? addSkill(out, name) : out
  }
  return out
}

/** Skill names from the session's usage breakdown, read once. */
async function skillNames($: EngineInterface): Promise<Set<string>> {
  if (live.skills) return live.skills
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    live.skills = new Set((usage.context.breakdown?.skills?.skillFrontmatter ?? []).map(s => s.name))
  } catch {
    live.skills = new Set()
  }
  return live.skills
}

/** Whether a slash command is a skill: among the breakdown's skills, else a `user` command. */
async function isSkill($: EngineInterface, name: string): Promise<boolean> {
  if (name === 'chat-sidecar') return false
  const names = await skillNames($)
  if (names.size > 0) return names.has(name)
  try {
    return (await $.command.list()).some(c => c.name === name && c.source === 'user')
  } catch {
    return false
  }
}

/** Memory files (CLAUDE.md, imports) and always-loaded skills, when Context files or Skills is shown. */
async function loadMemory($: EngineInterface) {
  if (!isShownSection('files') && !isShownSection('skills')) return
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const bd = usage.context.breakdown
    const skills = bd?.skills?.skillFrontmatter
    if (skills) live.skills = new Set(skills.map(s => s.name))
    const files = bd?.memoryFiles
    if (!files && !skills) return
    const paths = (files ?? []).map(f => f.path)
    await update($, inventoryAtom, inv => addMemoryFiles(inv, paths))
  } catch (err) {
    logError($, 'memory files', err)
  }
}

// ---- Seeding from history ----

async function seed($: EngineInterface, sessionId: string, startedAt: number) {
  const main = await $.session.messages()
  if (!Array.isArray(main)) return
  const uses: { tool_use_id: string; tool: string; input: Input; result?: unknown; isError?: boolean; agentId?: string; main: boolean }[] = []
  const commands: string[] = []
  for (const m of main) {
    if (m.role === 'user') {
      const name = /^\/([\w:.-]+)/.exec(m.text)?.[1] ?? /<command-name>\/([\w:.-]+)<\/command-name>/.exec(m.text)?.[1]
      if (name) commands.push(name)
    }
    for (const u of m.toolUses) uses.push({ ...u, input: u.input, isError: u.isError === true, main: true })
  }
  for (const u of [...uses]) {
    if (!u.agentId) continue
    const sub = await $.session.messages({ agentId: u.agentId }).catch(() => [])
    if (!Array.isArray(sub)) continue
    for (const m of sub) for (const t of m.toolUses) uses.push({ ...t, input: t.input, isError: t.isError === true, main: false })
  }

  let times = new Map<string, number>()
  if (uses.length > 0) {
    try {
      times = transcriptTimes(await $.fs.read(transcriptPath(live.home, live.cwd, sessionId)))
    } catch {
      times = new Map()
    }
  }

  let plan: Plan = EMPTY_PLAN
  let hasPlan = false
  let inv = await read($, inventoryAtom)
  for (const u of uses) {
    if (u.main) {
      if (u.tool === PLAN_TOOL) {
        plan = applyPlanTool(plan, u.input)
        hasPlan = true
      } else if (!u.isError && ['TodoWrite', 'TaskCreate', 'TaskUpdate'].includes(u.tool)) {
        const next =
          u.tool === 'TodoWrite' ? applyTodoWrite(plan, u.input) : u.tool === 'TaskCreate' ? applyTaskCreate(plan, u.input) : applyTaskUpdate(plan, u.input)
        if (next) {
          plan = next
          hasPlan = true
        }
      }
    }
    if (u.isError || live.counted.has(u.tool_use_id)) continue
    live.counted.add(u.tool_use_id)
    inv = countUse(inv, u.tool, u.input, times.get(u.tool_use_id) ?? null)
  }
  for (const name of commands) if (await isSkill($, name)) inv = addSkill(inv, name)
  if (differs(await read($, inventoryAtom), inv)) await update($, inventoryAtom, () => inv)

  if (hasPlan) {
    const stored = await read($, planAtom)
    // The replay is kept unless the stored plan changed since this start began.
    if (stored.stamp <= startedAt) await update($, planAtom, old => ({ ...plan, stamp: Math.max(old.stamp + 1, startedAt) }))
  }
}

// ---- Subagent cards ----

async function saveCards($: EngineInterface, change: (cards: readonly Card[]) => readonly Card[]) {
  await update($, cardsAtom, cards => pruneCards(change(cards)))
  await update($, clockAtom, t => t + 1)
  syncCardTimers($)
}

function newCard(id: string, description: string, type: string, model: string, now: number, cards: readonly Card[]): Card {
  const running = cards.filter(c => c.phase === 'working').map(c => c.color)
  const color = pickColor(live.lastColor, running)
  live.lastColor = color
  return { id, description, type, model, effort: '', phase: 'working', startMs: now, calls: 0, steps: [], tokens: 0, turnTokens: 0, usageSeen: false, seat: live.seat++, color }
}

/** A card for an agent id, adopted from `$.agent.list()` when missed; null for a foreign one. */
async function cardFor($: EngineInterface, agentId: string): Promise<boolean> {
  if (live.foreign.has(agentId)) return false
  if ((await read($, cardsAtom)).some(c => c.id === agentId)) return true
  const listed = await $.agent.list().catch(() => [])
  const info = listed.find(a => a.id === agentId)
  if (!info) {
    live.foreign.add(agentId)
    return false
  }
  const now = await $.clock.now()
  await saveCards($, cards => (cards.some(c => c.id === agentId) ? cards : [...cards, newCard(agentId, info.description || 'Subagent', info.type || 'subagent', '', now, cards)]))
  return true
}

function nameOfServer(server: string, tool: string) {
  return serverName(server, tool, live.serverNames)
}

async function noteAgentCall($: EngineInterface, agentId: string, tool: string, input: Input) {
  if (!(await cardFor($, agentId))) return
  const step = stepOf(tool, input, live.home, nameOfServer)
  await saveCards($, cards => cards.map(c => (c.id === agentId ? withStep(c, step) : c)))
}

/** Timers run while a card works, the mod is on and Subagents is shown. */
function syncCardTimers($: EngineInterface) {
  void (async () => {
    const working = (await read($, cardsAtom)).some(c => c.phase === 'working')
    const want = working && !live.off && isShownSection('subagents')
    if (want && !live.cardTick) {
      live.cardTick = $.clock.every(CARD_TICK_MS, () => void update($, clockAtom, t => t + 1).catch(() => undefined))
      live.cardPoll = $.clock.every(CARD_POLL_MS, () => void pollAgents($).catch(err => logError($, 'agents', err)))
    }
    if (!want && live.cardTick) {
      live.cardTick.cancel()
      live.cardPoll?.cancel()
      live.cardTick = null
      live.cardPoll = null
    }
  })().catch(err => logError($, 'card timers', err))
}

async function pollAgents($: EngineInterface) {
  const cards = await read($, cardsAtom)
  if (!cards.some(c => c.phase === 'working')) return
  const listed = await $.agent.list()
  const now = await $.clock.now()
  let changed = false
  const next = cards.map(c => {
    const info = listed.find(a => a.id === c.id)
    if (!info) return c
    let card = c
    if (!card.description && info.description) card = { ...card, description: info.description }
    if (card.phase === 'working' && (info.status === 'completed' || info.status === 'idle')) card = { ...card, phase: 'done', endMs: now }
    if (card.phase === 'working' && (info.status === 'failed' || info.status === 'killed')) card = { ...card, phase: 'failed', endMs: now }
    if (card !== c) changed = true
    return card
  })
  if (changed) await saveCards($, () => next)
}

// ---- Background and Git ----

async function scanBackground($: EngineInterface) {
  if (live.off || !isShownSection('background')) return
  try {
    const prev = await read($, listenersAtom)
    const found = await poll($, live.cfg, live.windows, prev)
    if (found === null || live.off) return
    await update($, listenersAtom, () => found)
    invalidate($)
  } catch (err) {
    logError($, 'background', err)
  }
}

async function refreshGit($: EngineInterface) {
  if (live.off || !isShownSection('git')) return
  try {
    const info = await readGit($)
    if (live.off) return
    if (differs(await read($, gitAtom), info)) {
      await update($, gitAtom, () => info)
      invalidate($)
    }
  } catch (err) {
    logError($, 'git', err)
  }
}

// ---- Settings writes ----

type Rows = { key: string; field: string; value: unknown; isLocked: boolean }[]

async function ownRows($: EngineInterface): Promise<Rows> {
  try {
    return (await $.config.list())
      .filter(r => r.key.startsWith(`${PLUGIN}.`) || r.key.startsWith(`${PLUGIN}@`))
      .map(r => ({ key: r.key, field: r.key.slice(r.key.lastIndexOf('.') + 1), value: r.value, isLocked: r.isLocked }))
  } catch {
    return []
  }
}

/** Writes a field unless its row is locked, missing or already equal. */
async function writeField($: EngineInterface, rows: Rows, field: string, value: string | boolean) {
  const row = rows.find(r => r.field === field)
  if (!row || row.isLocked || row.value === value) return
  try {
    const result = await $.config.set({ key: row.key, value })
    if (result.deny) logError($, 'settings', new Error(`${field}: ${result.deny}`))
  } catch (err) {
    logError($, 'settings', err)
  }
}

// ---- Drawing: shared pieces ----

/** Cells of a bar as Texts, runs of one look together. */
function cellsEl(els: Els, cells: readonly Cell[], key?: string) {
  const { Box, Text } = els
  const runs: { text: string; color?: string; dim?: boolean }[] = []
  for (const c of cells) {
    const last = runs.at(-1)
    if (last && last.color === c.color && last.dim === c.dim) last.text += c.ch
    else runs.push({ text: c.ch, ...(c.color ? { color: c.color } : {}), ...(c.dim ? { dim: true } : {}) })
  }
  return (
    <Box key={key} flexShrink={0}>
      <Text>
        {runs.map(r => (
          <Text color={r.color} dimColor={r.dim}>
            {r.text}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

/** A list capped at 40 rows with a dim `+N more`. */
function capped(els: Els, rows: readonly RenderElement[], max = MAX_ROWS): RenderElement[] {
  const { Text } = els
  return rows.length <= max ? [...rows] : [...rows.slice(0, max), <Text dimColor>{`+${rows.length - max} more`}</Text>]
}

function dimLine(els: Els, text: string, width: number) {
  const { Text, Box } = els
  return (
    <Box flexDirection="column">
      {wrap(text, width).map(line => (
        <Text dimColor>{line}</Text>
      ))}
    </Box>
  )
}

/** A label left, a value right, on one row. */
function spread(els: Els, left: RenderElement, right: RenderElement | null, key?: string) {
  const { Box } = els
  return (
    <Box key={key} flexDirection="row" justifyContent="space-between" width="100%">
      <Box flexShrink={1}>{left}</Box>
      {right ? <Box flexShrink={0}>{right}</Box> : null}
    </Box>
  )
}

// ---- Drawing: sections ----

type View = {
  els: Els
  surface: RenderSurface
  inner: number
  now: number
  hasSvg: boolean
}

async function todoSection($: EngineInterface, v: View): Promise<{ count: string; body: RenderElement }> {
  const { els, inner } = v
  const { Box, Text } = els
  const plan = await read($, planAtom)
  if (plan.steps.length === 0) return { count: '', body: dimLine(els, TEXT.noPlan, inner) }
  const textW = inner - 2
  return {
    count: `${planDone(plan)} of ${plan.steps.length}`,
    body: (
      <Box flexDirection="column">
        {plan.title
          ? wrap(plan.title, inner).map(l => (
              <Text dimColor>{l}</Text>
            ))
          : null}
        {plan.steps.map((s, i) => {
          const isLive = s.status === 'in_progress'
          const isDone = s.status === 'completed'
          const text = isLive && s.activeForm ? s.activeForm : s.text
          return (
            <Box key={`step-${i}`} flexDirection="row">
              <Box width={2} flexShrink={0}>
                {isDone ? <Text color="success">✓</Text> : isLive ? <Text color={ACCENT}>●</Text> : <Text dimColor>○</Text>}
              </Box>
              <Box flexDirection="column">
                {wrap(text, textW).map(line => (
                  <Text bold={isLive} dimColor={isDone} strikethrough={isDone}>
                    {line}
                  </Text>
                ))}
              </Box>
            </Box>
          )
        })}
      </Box>
    ),
  }
}

function cardEl($: EngineInterface, v: View, card: Card, tick: number, expanded: boolean, style: BarStyle): RenderElement {
  const { els, inner } = v
  const { Box, Text, Button } = els
  const w = Math.max(10, inner - 4)
  const isWorking = card.phase === 'working'
  const hex = CARD_HEX[CARD_COLORS[card.color % CARD_COLORS.length]!]
  const mark = isWorking ? <Text color="success">●</Text> : card.phase === 'done' ? <Text color="success">✓</Text> : <Text color="error">✗</Text>
  const meta = [card.type, card.model, card.effort].filter(Boolean).join(' · ')
  const secs = ((isWorking ? v.now : (card.endMs ?? v.now)) - card.startMs) / 1000
  const right = `${card.usageSeen ? `${tokens(card.tokens + card.turnTokens)} tokens · ` : ''}${elapsed(secs)}`
  const newest = card.steps.at(-1)
  const spinner = '⠋⠙⠹⠸'[tick % 4]!
  const pulse = ['·  ', '·· ', '···', ' ··'][tick % 4]!
  const n = card.calls
  const lead = isWorking ? (
    <Text>
      <Text color={ACCENT}>{`${spinner} `}</Text>
      <Text bold color={ACCENT}>{`Step ${n} · ${newest ? newest.live : 'Getting started'}`}</Text>
      <Text color={ACCENT}>{` ${pulse}`}</Text>
    </Text>
  ) : card.phase === 'done' ? (
    <Text color="success">{`Done · ${plural(n, 'step')}`}</Text>
  ) : (
    <Text color="error">{`Stopped before it finished · ${plural(n, 'step')}`}</Text>
  )
  const recent = isWorking ? card.steps.slice(-4, -1) : card.steps.slice(-3)
  const [before, piece, after] = agentParts(style, card.phase, w, tick, card.seat)
  const kept = card.steps.length
  return (
    <Box key={`card-${card.id}`} flexDirection="column" borderStyle="round" borderColor={isWorking ? hex : undefined} borderDimColor={!isWorking} paddingX={1} width="100%" flexShrink={0}>
      {spread(els, <Text bold wrap="truncate-end">{card.description}</Text>, mark)}
      {spread(els, <Text dimColor wrap="truncate-end">{meta}</Text>, <Text dimColor>{right}</Text>)}
      <Box>{lead}</Box>
      {!expanded
        ? recent.map(s => (
            <Text dimColor wrap="truncate-end">{`  ${s.live}`}</Text>
          ))
        : null}
      <Text>
        <Text dimColor>{before}</Text>
        <Text color={card.phase === 'failed' ? 'error' : hex}>{piece}</Text>
        <Text dimColor>{after}</Text>
      </Text>
      {kept > 0 ? (
        <Button key={`steps-${card.id}`} plain onPress={() => toggleIn($, 'expanded', card.id)}>
          <Text dimColor>{expanded ? '▾ Hide steps' : `▸ All ${plural(n, 'step')}`}</Text>
        </Button>
      ) : null}
      {expanded && n > kept ? <Text dimColor>{`${n - kept} older steps not kept`}</Text> : null}
      {expanded ? card.steps.map((s, i) => stepRow(els, s, w, i)) : null}
    </Box>
  )
}

/** A kept step: an 11-cell kind column, the label, and the folder in dim when it fits. */
function stepRow(els: Els, s: Step, w: number, i: number): RenderElement {
  const { Box, Text } = els
  const rowW = Math.max(1, w - 11)
  let label = s.label
  let folder = ''
  if (label.length >= rowW) label = cut(label, rowW)
  else if (s.dim) {
    const room = rowW - label.length - 2
    if (room >= 4) folder = s.dim.length > room ? `…${s.dim.slice(s.dim.length - room + 1)}` : s.dim
  }
  return (
    <Box key={`s-${i}`} flexDirection="row">
      <Box width={11} flexShrink={0}>
        <Text color={KIND_COLORS[s.kind]}>{KIND_NAMES[s.kind]}</Text>
      </Box>
      <Text wrap="truncate-end">
        {label}
        {folder ? <Text dimColor>{`  ${folder}`}</Text> : null}
      </Text>
    </Box>
  )
}

async function toggleIn($: EngineInterface, field: 'expanded' | 'folded', id: string) {
  await update($, cardsViewAtom, view => {
    const list = view[field]
    return { ...view, [field]: list.includes(id) ? list.filter(x => x !== id) : [...list, id] }
  })
}

async function subagentsSection($: EngineInterface, v: View): Promise<{ count: string; body: RenderElement }> {
  const { els, inner } = v
  const { Box, Text, Button } = els
  const cards = await read($, cardsAtom)
  const view = await read($, cardsViewAtom)
  const tick = await read($, clockAtom)
  if (cards.length === 0) return { count: '', body: dimLine(els, TEXT.noAgents, inner) }
  const running = cards.filter(c => c.phase === 'working').length
  const groups = [
    { id: 'running', title: 'Running', cards: cards.filter(c => c.phase === 'working') },
    { id: 'finished', title: 'Finished', cards: cards.filter(c => c.phase === 'done') },
    { id: 'stopped', title: 'Stopped', cards: cards.filter(c => c.phase === 'failed') },
  ].filter(g => g.cards.length > 0)
  return {
    count: `${running} running of ${cards.length}`,
    body: (
      <Box flexDirection="column">
        {groups.map(g => {
          const folded = view.folded.includes(g.id)
          const isRun = g.id === 'running'
          const look = isRun ? { color: 'white', bold: true } : g.id === 'stopped' ? { color: 'error', bold: true } : { bold: true }
          const heading = `${g.title} · ${g.cards.length}`
          return (
            <Box key={`group-box-${g.id}`} flexDirection="column">
              <Box key={`head-${g.id}`} flexDirection="row" width="100%" backgroundColor={isRun ? 'blue' : undefined}>
                <Button key={`group-${g.id}`} plain onPress={() => toggleIn($, 'folded', g.id)}>
                  <Text {...look}>{folded ? '▸ ' : '▾ '}</Text>
                </Button>
                <Text {...look}>{heading.padEnd(Math.max(0, inner - 2))}</Text>
              </Box>
              {folded ? null : g.cards.map(c => cardEl($, v, c, tick, view.expanded.includes(c.id), live.cfg.barStyle))}
            </Box>
          )
        })}
      </Box>
    ),
  }
}

function logoSvg(key: string, name: string, count: number): string {
  const logo = LOGOS[key]
  const badge = count > 99 ? '99+' : String(count)
  const bw = badge.length > 2 ? 20 : 16
  const icon = logo
    ? `<rect x="2" y="6" width="32" height="32" rx="8" fill="#ffffff" stroke="#d0d0d0"/><g transform="translate(6 10)"><path fill="${logo.hex}" d="${logo.path}"/></g>`
    : `<rect x="2" y="6" width="32" height="32" rx="8" fill="${ACCENT_HEX}"/><text x="18" y="28" text-anchor="middle" font-family="system-ui,sans-serif" font-size="16" font-weight="700" fill="#ffffff">${(name.trim()[0] ?? '?').toUpperCase().replace('<', '&lt;').replace('&', '&amp;')}</text>`
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="40" viewBox="0 0 44 40">',
    icon,
    `<rect x="${44 - bw}" y="0" width="${bw}" height="16" rx="8" fill="${ACCENT_HEX}"/>`,
    `<text x="${44 - bw / 2}" y="12" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#ffffff">${badge}</text>`,
    '</svg>',
  ].join('')
}

async function connectorsSection($: EngineInterface, v: View): Promise<{ count: string; body: RenderElement }> {
  const { els, inner } = v
  const { Box, Text, Button } = els
  const inv = await read($, inventoryAtom)
  const open = await read($, openConnectorAtom)
  const rows = connectorsShown(inv)
  const count = String(rows.length)
  if (rows.length === 0) return { count, body: <Text dimColor>{TEXT.noneUsed}</Text> }
  const press = (key: string) => () => void update($, openConnectorAtom, o => (o === key ? null : key))
  const tag = (r: (typeof rows)[number]) => (r.cli && r.mcp ? 'MCP + CLI' : r.cli ? 'via CLI' : '')
  const callList = (r: (typeof rows)[number]) => {
    const calls = [...r.calls].reverse()
    return (
      <Box key={`calls-${r.key}`} flexDirection="column" paddingLeft={1}>
        <Text dimColor>{`${r.name} calls, newest first`}</Text>
        {capped(
          els,
          calls.map((c, i) =>
            spread(
              els,
              <Text wrap="truncate-end">
                {c.text}
                {c.summary ? <Text dimColor>{`  ${c.summary}`}</Text> : null}
              </Text>,
              <Text dimColor>{`${c.cli ? 'CLI ' : ''}${clockOf(c.at)}`}</Text>,
              `call-${i}`,
            ),
          ),
        )}
      </Box>
    )
  }
  if (v.hasSvg && 'Svg' in els) {
    const Svg = (els as unknown as { Svg: unknown }).Svg as (p: { source: string; alt: string; width: number; height: number }) => RenderElement
    const perRow = Math.max(1, Math.floor(inner / 12))
    const lines: (typeof rows)[] = []
    for (let i = 0; i < rows.length; i += perRow) lines.push(rows.slice(i, i + perRow))
    return {
      count,
      body: (
        <Box flexDirection="column">
          {lines.map((line, li) => {
            const opened = line.find(r => r.key === open)
            return (
              <Box key={`tiles-${li}`} flexDirection="column">
                <Box flexDirection="row">
                  {line.map(r => (
                    <Box key={`tile-${r.key}`} flexDirection="column" width={12} flexShrink={0}>
                      <Svg source={logoSvg(r.key, r.name, r.count)} alt={`${r.name}, ${plural(r.count, 'call')}`} width={44} height={40} />
                      <Button key={`c:${r.key}`} plain onPress={press(r.key)}>
                        <Text dimColor={open !== r.key}>{r.name}</Text>
                      </Button>
                      <Text dimColor>{tag(r) || ' '}</Text>
                    </Box>
                  ))}
                </Box>
                {opened ? callList(opened) : null}
              </Box>
            )
          })}
        </Box>
      ),
    }
  }
  return {
    count,
    body: (
      <Box flexDirection="column">
        {rows.map(r => (
          <Box key={`conn-${r.key}`} flexDirection="column">
            {spread(
              els,
              <Button key={`c:${r.key}`} plain onPress={press(r.key)}>
                {`${open === r.key ? '▾' : '▸'} ${r.name}`}
                {tag(r) ? <Text dimColor>{` ${tag(r)}`}</Text> : ''}
              </Button>,
              <Text color={ACCENT}>{plural(r.count, 'call')}</Text>,
            )}
            {open === r.key ? callList(r) : null}
          </Box>
        ))}
      </Box>
    ),
  }
}

async function filesSection($: EngineInterface, v: View): Promise<{ count: string; body: RenderElement }> {
  const { els } = v
  const { Box, Text, Button } = els
  const inv = await read($, inventoryAtom)
  const rows = filesShown(inv)
  const count = String(rows.length)
  if (rows.length === 0) return { count, body: <Text dimColor>{TEXT.noneUsed}</Text> }
  const top = clampTop(await read($, filesTopAtom), rows.length)
  const shown = rows.length > FILES_WINDOW ? rows.slice(top, top + FILES_WINDOW) : rows
  const move = (by: number) => () => void update($, filesTopAtom, t => clampTop(clampTop(t, rows.length) + by, rows.length))
  const atTop = top === 0
  const atEnd = top + FILES_WINDOW >= rows.length
  return {
    count,
    body: (
      <Box flexDirection="column">
        {spread(els, <Text dimColor>Files read</Text>, <Text dimColor>{String(rows.filter(r => !r.auto).length)}</Text>)}
        {shown.map(r =>
          spread(
            els,
            <Text wrap="truncate-end">
              {fileName(r.path)}
              <Text dimColor>{`  ${shownFolder(r.path, live.home)}`}</Text>
            </Text>,
            r.auto ? <Text color="suggestion">auto</Text> : null,
            `file-${r.path}`,
          ),
        )}
        {rows.length > FILES_WINDOW ? (
          <Box flexDirection="row" columnGap={2}>
            <Text dimColor>{`${top + 1} to ${Math.min(rows.length, top + FILES_WINDOW)} of ${rows.length}`}</Text>
            {atTop ? (
              <Text dimColor>▴ Up</Text>
            ) : (
              <Button key="files-up" plain onPress={move(-FILES_STEP)}>
                <Text dimColor>▴ Up</Text>
              </Button>
            )}
            {atEnd ? (
              <Text dimColor>▾ Down</Text>
            ) : (
              <Button key="files-down" plain onPress={move(FILES_STEP)}>
                <Text dimColor>▾ Down</Text>
              </Button>
            )}
          </Box>
        ) : null}
      </Box>
    ),
  }
}

async function skillsSection($: EngineInterface, v: View): Promise<{ count: string; body: RenderElement }> {
  const { els } = v
  const { Box, Text } = els
  const rows = skillsShown(await read($, inventoryAtom))
  const count = String(rows.length)
  if (rows.length === 0) return { count, body: <Text dimColor>{TEXT.noneUsed}</Text> }
  return {
    count,
    body: (
      <Box flexDirection="column">
        {capped(
          els,
          rows.map(s =>
            spread(
              els,
              <Text wrap="truncate-end">
                <Text color={ACCENT}>/</Text>
                {s.name}
              </Text>,
              <Text>
                {s.always ? <Text color="suggestion">always loaded</Text> : ''}
                {s.always && s.count > 0 ? '  ' : ''}
                {s.count > 0 ? <Text dimColor>{plural(s.count, 'use')}</Text> : ''}
              </Text>,
              `skill-${s.name}`,
            ),
          ),
        )}
      </Box>
    ),
  }
}

const AGE_LOOK = { ok: { dimColor: true }, warning: { color: 'warning' }, error: { color: 'error', bold: true } } as const

async function backgroundSection($: EngineInterface, v: View): Promise<{ count: string; body: RenderElement }> {
  const { els, inner } = v
  const { Box, Text, Button } = els
  const Link = 'Link' in els ? (els as { Link: unknown }).Link as (p: { href: string; label?: string }) => RenderElement : undefined
  const list = await read($, listenersAtom)
  const open = await read($, bgOpenAtom)
  const hideIdle = await read($, bgHideIdleAtom)
  const cfg = live.cfg
  const groups = portGroups(cfg.watched, list.filter(l => l.port !== undefined))
  const runs = list.filter(l => l.port === undefined)
  const allPorts = groups.flatMap(g => g.ports)
  const up = allPorts.filter(p => p.state === 'up').length
  const foreign = allPorts.filter(p => p.state === 'foreign').length
  const count = allPorts.length > 0 ? `${up} of ${allPorts.length} up${foreign > 0 ? ` · ${foreign} ⚠` : ''}` : runs.length > 0 ? String(runs.length) : ''
  if (groups.length === 0 && runs.length === 0) return { count, body: <Text dimColor>{TEXT.nothingBg}</Text> }
  const labelW = Math.min(12, Math.max(...groups.map(g => g.label.length), 1))
  const idleGroups = groups.filter(g => g.ports.every(p => p.state === 'idle'))
  const palette = PALETTES[cfg.bandColor]
  return {
    count,
    body: (
      <Box flexDirection="column">
        {groups.map(g => {
          const isIdle = idleGroups.includes(g)
          if (isIdle && hideIdle) return null
          const isDebug = g.label === 'debug'
          const detail = g.ports.find(p => p.port === open)
          return (
            <Box key={`bg-group-${g.label}`} flexDirection="column">
              <Box flexDirection="row">
                <Box width={labelW + 1} flexShrink={0}>
                  <Text color={isDebug ? 'permission' : undefined} wrap="truncate-end">
                    {cut(g.label, labelW)}
                  </Text>
                </Box>
                <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                  {g.ports.map(p => (
                    <Button key={`bg-port-${p.port}`} plain onPress={() => void update($, bgOpenAtom, o => (o === p.port ? null : p.port))}>
                      {p.state === 'up' ? (
                        <Text>
                          {`:${p.port} `}
                          <Text color={isDebug ? 'permission' : 'success'}>●</Text>
                          <Text {...AGE_LOOK[level(p.entry!, cfg.age)]}>{` ${ago(p.entry!.minutes)}`}</Text>
                        </Text>
                      ) : p.state === 'idle' ? (
                        <Text dimColor>{`:${p.port} ○`}</Text>
                      ) : (
                        <Text color="warning">{`:${p.port} ⚠ ${bareImage(p.entry!.image)}`}</Text>
                      )}
                    </Button>
                  ))}
                </Box>
              </Box>
              {detail ? (
                <Box key={`bg-detail-${detail.port}`} flexDirection="column" paddingLeft={2}>
                  <Text dimColor wrap="truncate-end">
                    {detail.entry ? `:${detail.port} · ${detail.entry.image} · pid ${detail.entry.pid}` : `:${detail.port} · nothing listening`}
                  </Text>
                  {detail.state === 'foreign'
                    ? wrap(`${detail.entry!.image} holds the port, so the ${g.label} server cannot start on it.`, inner - 2).map(l => <Text color="warning">{l}</Text>)
                    : null}
                  {detail.state === 'up' && !isDebug && Link ? <Link href={`http://localhost:${detail.port}`} label={`http://localhost:${detail.port}`} /> : null}
                </Box>
              ) : null}
            </Box>
          )
        })}
        {idleGroups.length > 0 ? (
          <Button key="bg-idle" plain onPress={() => void update($, bgHideIdleAtom, h => !h)}>
            <Text dimColor>{hideIdle ? `▸ ${idleGroups.length} idle` : `▾ hide ${idleGroups.length} idle`}</Text>
          </Button>
        ) : null}
        {runs.length > 0 ? (
          <Text dimColor bold>
            Tests
          </Text>
        ) : null}
        {runs.map(r => {
          const total = r.progress?.total
          const hasTotal = r.progress !== undefined && total !== undefined && r.progress.done <= total
          return (
            <Box key={`run-${r.key}`} flexDirection="row" columnGap={1}>
              <Text color="suggestion">◐</Text>
              <Box flexShrink={1}>
                <Text wrap="truncate-end">{`${r.label}${r.count > 1 ? ` ×${r.count}` : ''}`}</Text>
              </Box>
              {hasTotal
                ? cellsEl(els, planCells(cfg.barStyle, { done: r.progress!.done, total: total!, isLive: false, barW: 10, tick: 0, palette }), `bar-${r.key}`)
                : null}
              {r.progress ? <Text dimColor>{hasTotal ? `${r.progress.done}/${total}` : String(r.progress.done)}</Text> : null}
              <Text {...AGE_LOOK[level(r, cfg.age)]}>{ago(r.minutes)}</Text>
            </Box>
          )
        })}
      </Box>
    ),
  }
}

async function gitSection($: EngineInterface, v: View, info: GitInfo): Promise<{ count: string; body: RenderElement }> {
  const { els, inner } = v
  const { Box, Text } = els
  const row = (key: string, label: string, value: RenderElement) => (
    <Box key={key} flexDirection="row" justifyContent="space-between" width="100%">
      <Box flexShrink={0} marginRight={1}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexShrink={1}>{value}</Box>
    </Box>
  )
  const main = info.mainRepo !== undefined ? cut(homeShort(info.mainRepo, live.home), Math.max(8, inner - 11)) : undefined
  return {
    count: info.branch,
    body: (
      <Box flexDirection="column">
        {row(
          'git-base',
          'Base',
          info.base ? (
            <Text wrap="truncate-end">
              {info.base}
              {info.baseCommit ? <Text dimColor>{` · ${info.baseCommit}`}</Text> : ''}
            </Text>
          ) : (
            <Text dimColor>unknown</Text>
          ),
        )}
        {row('git-worktree', 'Worktree', <Text>{info.isWorktree ? 'yes' : 'no'}</Text>)}
        {main !== undefined ? row('git-main', 'Main repo', <Text wrap="truncate-start">{main}</Text>) : null}
      </Box>
    ),
  }
}

// ---- Drawing: the frame ----

function sectionFrame($: EngineInterface, v: View, id: SectionId, open: boolean, count: string, body: RenderElement | null, waits: boolean): RenderElement {
  const { Box, Text, Button } = v.els
  const tone = waits ? 'warning' : undefined
  return (
    <Box key={id} flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1} width="100%" flexShrink={0}>
      <Box flexDirection="row" justifyContent="space-between" width="100%">
        <Button key={`sec-${id}`} plain onPress={() => void update($, foldedAtom, f => (f.includes(id) ? f.filter(x => x !== id) : [...f, id]))}>
          <Text color={tone ?? ACCENT}>{open ? '▾ ' : '▸ '}</Text>
          <Text bold color={tone}>
            {TITLES[id]}
          </Text>
        </Button>
        {count ? (
          <Text dimColor={!waits} bold={waits} color={tone}>
            {count}
          </Text>
        ) : null}
      </Box>
      {open && body ? body : null}
    </Box>
  )
}

async function drawPane($: EngineInterface, els: Els, surface: RenderSurface, isFocused: boolean, bodyColumns: number | undefined): Promise<RenderElement> {
  const { Box, Text, Button } = els
  const width = Math.max(20, bodyColumns ?? 20)
  const inner = width - 4
  if (await read($, offAtom)) {
    tasksUndrawn(surface)
    return dimLine(els, TEXT.offLine, width)
  }
  const screen = await read($, screenAtom)
  if (screen.open) {
    tasksUndrawn(surface)
    return drawSettings($, els, surface, width, screen)
  }
  const v: View = { els, surface, inner, now: await $.clock.now(), hasSvg: surface !== 'terminal' && 'Svg' in els }
  const folded = await read($, foldedAtom)
  const tasks = await read($, tasksAtom)
  const shown = live.cfg.sections.shown
  const git = shown.git ? await read($, gitAtom) : null
  const sections: RenderElement[] = []
  let tasksDrawn = false
  for (const id of live.cfg.sections.order) {
    const open = !folded.includes(id)
    try {
      if (id === 'tasks') {
        if (!shown.tasks && !tasks.some(isShown)) continue
        const openCount = tasks.filter(t => t.state === 'open').length
        let body: RenderElement | null = null
        if (open) {
          body = await tasksSection($, els, surface, isFocused, inner)
          tasksDrawn = true
        }
        sections.push(sectionFrame($, v, id, open, openCount > 0 ? String(openCount) : '', body, openCount > 0))
        continue
      }
      if (!shown[id]) continue
      if (id === 'git' && git === null) continue
      const drawn =
        id === 'todo'
          ? await todoSection($, v)
          : id === 'subagents'
            ? await subagentsSection($, v)
            : id === 'background'
              ? await backgroundSection($, v)
              : id === 'connectors'
                ? await connectorsSection($, v)
                : id === 'files'
                  ? await filesSection($, v)
                  : id === 'skills'
                    ? await skillsSection($, v)
                    : await gitSection($, v, git!)
      sections.push(sectionFrame($, v, id, open, drawn.count, drawn.body, false))
    } catch (err) {
      logError($, `draw ${id}`, err)
    }
  }
  if (!tasksDrawn) tasksUndrawn(surface)
  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="row" width="100%">
        <Box key="title" flexGrow={1}>
          <Text bold color={ACCENT}>
            {PANE_TITLE}
          </Text>
        </Box>
        <Button key="pane-settings" label="⚙ Settings" dimColor onPress={() => void update($, screenAtom, s => ({ ...s, open: true }))} />
        <Text> </Text>
        <Button key="pane-hide" label="Hide" dimColor onPress={() => hidePane($)} />
      </Box>
      {sections.length > 0 ? sections : dimLine(els, TEXT.allOff, width)}
    </Box>
  )
}

// ---- Drawing: settings ----

async function drawSettings($: EngineInterface, els: Els, surface: RenderSurface, width: number, screen: SettingsScreen): Promise<RenderElement> {
  const { Box, Text, Button } = els
  const rows = await ownRows($)
  const locked = (field: string) => rows.find(r => r.field === field)?.isLocked === true
  const cfg = live.cfg
  const order = cfg.sections.order
  const orderLocked = locked('sectionOrder')
  const box = (key: string, children: (RenderElement | null)[]) => (
    <Box key={key} flexDirection="column" borderStyle="round" paddingX={1} width="100%" flexShrink={0}>
      {children}
    </Box>
  )
  const writeOrder = async (from: number, to: number) => {
    const next = [...order]
    const [a, b] = [next[from]!, next[to]!]
    next[from] = b
    next[to] = a
    await writeField($, await ownRows($), 'sectionOrder', next.join(', '))
  }

  const sectionRows = order.map((id, i) => {
    const field = SHOW_FIELD[id]
    const on = cfg.sections.shown[id]
    const isLocked = locked(field)
    const toggle = isLocked ? (
      <Text dimColor>{`${on ? '[x]' : '[ ]'} ${TITLES[id]} (set by your organisation)`}</Text>
    ) : (
      <Button key={`set-show-${id}`} plain onPress={() => void ownRows($).then(r => writeField($, r, field, !on))}>
        <Text color={on ? ACCENT : undefined}>{on ? '[x] ' : '[ ] '}</Text>
        {TITLES[id]}
      </Button>
    )
    const upOk = i > 0 && !orderLocked
    const downOk = i < order.length - 1 && !orderLocked
    return spread(
      els,
      toggle,
      <Box flexDirection="row" columnGap={1}>
        {upOk ? (
          <Button key={`set-up-${id}`} plain onPress={() => void writeOrder(i, i - 1)}>
            ▲
          </Button>
        ) : (
          <Text dimColor>▲</Text>
        )}
        {downOk ? (
          <Button key={`set-down-${id}`} plain onPress={() => void writeOrder(i, i + 1)}>
            ▼
          </Button>
        ) : (
          <Text dimColor>▼</Text>
        )}
      </Box>,
      `set-row-${id}`,
    )
  })

  const colorLocked = locked('bandColor')
  const colors = (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {BAND_COLOR_IDS.map((c: BandColor) => {
        const chosen = c === cfg.bandColor
        const label = <Text color={PALETTES[c].mid} bold={chosen}>{`${chosen ? '◉' : '○'} ${BAND_COLOR_NAMES[c]}`}</Text>
        return chosen || colorLocked ? (
          <Box key={`set-color-box-${c}`}>{label}</Box>
        ) : (
          <Button key={`set-color-${c}`} plain onPress={() => void ownRows($).then(r => writeField($, r, 'bandColor', c))}>
            {label}
          </Button>
        )
      })}
    </Box>
  )

  const barLocked = locked('barStyle')
  const palette = PALETTES[cfg.bandColor]
  const styles = BAR_STYLE_IDS.map((s: BarStyle) => {
    const chosen = s === cfg.barStyle
    const preview = cellsEl(els, planCells(s, { done: 3, total: 5, isLive: true, barW: 10, tick: 0, palette }))
    const label = <Text bold={chosen}>{`${chosen ? '◉' : '○'} ${BAR_STYLE_NAMES[s].padEnd(9)}`}</Text>
    return (
      <Box key={`set-bar-row-${s}`} flexDirection="row" columnGap={1}>
        {chosen || barLocked ? (
          label
        ) : (
          <Button key={`set-bar-${s}`} plain onPress={() => void ownRows($).then(r => writeField($, r, 'barStyle', s))}>
            {label}
          </Button>
        )}
        {preview}
      </Box>
    )
  })

  const Input = surface !== 'mobile' && 'Input' in els ? (els as { Input: unknown }).Input as (p: Record<string, unknown>) => RenderElement : undefined
  const portsLocked = locked('ports')
  const portsValue = screen.portsDraft ?? live.rawPorts ?? DEFAULT_PORTS
  const ports =
    Input && !portsLocked ? (
      <Input
        key="set-ports"
        label="Ports "
        placeholder="8090=backend, 4200=frontend"
        submitLabel="save"
        value={portsValue}
        onInput={(value: string) => void update($, screenAtom, s => ({ ...s, portsDraft: value }))}
        onSubmit={(value: string) => void submitPorts($, value)}
      />
    ) : (
      <Text dimColor>{`${(live.rawPorts ?? DEFAULT_PORTS) || 'none'}${portsLocked ? ' (set by your organisation)' : ' (edit in /config)'}`}</Text>
    )

  return (
    <Box flexDirection="column" width={width}>
      {box('set-sections', [
        <Text bold>Sections</Text>,
        ...sectionRows,
        <Text dimColor>Off, a section is not drawn and its background work stops.</Text>,
      ])}
      {box('set-colors', [<Text bold>Plan band colour</Text>, colors])}
      {box('set-bars', [<Text bold>Bar style</Text>, <Text dimColor>The terminal's plan band and subagent bars.</Text>, ...styles])}
      {box('set-ports-box', [
        <Text bold>Background ports</Text>,
        ports,
        screen.portsError ? <Text color="error">{screen.portsError}</Text> : <Text dimColor>port=label, separated by commas; Enter saves.</Text>,
      ])}
      <Box flexDirection="row" columnGap={2}>
        <Button key="set-done" label="Done" onPress={() => void update($, screenAtom, () => ({ open: false, portsError: null, portsDraft: null }))} />
        <Button key="set-reset" label="Reset to defaults" dimColor onPress={() => void resetSettings($)} />
      </Box>
    </Box>
  )
}

async function submitPorts($: EngineInterface, value: string) {
  const bad = badPorts(value)
  if (bad.length > 0) {
    await update($, screenAtom, s => ({ ...s, portsDraft: value, portsError: `Not understood: ${bad.join(', ')} (expected port=label)` }))
    return
  }
  await update($, screenAtom, s => ({ ...s, portsError: null, portsDraft: null }))
  await writeField($, await ownRows($), 'ports', value.trim())
}

async function resetSettings($: EngineInterface) {
  await update($, screenAtom, s => ({ ...s, portsError: null, portsDraft: null }))
  const rows = await ownRows($)
  for (const id of SECTION_IDS) await writeField($, rows, SHOW_FIELD[id], true)
  await writeField($, rows, 'sectionOrder', DEFAULT_ORDER)
  await writeField($, rows, 'ports', DEFAULT_PORTS)
  await writeField($, rows, 'bandColor', 'purple')
  await writeField($, rows, 'barStyle', 'gradient')
}

// ---- Drawing: the band ----

async function drawBand($: EngineInterface, els: Els, surface: RenderSurface, bodyColumns: number | undefined, below: RenderElement): Promise<RenderElement | null> {
  const { Box, Text, Button } = els
  const tasks = await read($, tasksAtom)
  const open = tasks.filter(t => t.state === 'open').length
  const plan = await read($, planAtom)
  const band = await read($, bandAtom)
  const hidden = await read($, hiddenAtom)
  const showPlan = !hidden && isShownSection('todo') && band.shown && plan.steps.length > 0
  if (!showPlan && open === 0) return null
  const countBtn =
    open > 0 ? (
      <Button key="band-tasks" plain onPress={() => void tasksShow($).catch(err => logError($, 'band tasks', err))}>
        <Text bold color="warning">{`● ${open} for you`}</Text>
      </Button>
    ) : null
  const lower = below && (below as { type?: string }).type !== 'engine' ? below : null
  if (!showPlan) {
    return (
      <Box flexDirection="column">
        {lower}
        <Box flexDirection="row">{countBtn}</Box>
      </Box>
    )
  }
  const done = planDone(plan)
  const total = plan.steps.length
  const liveIndex = plan.steps.findIndex(s => s.status === 'in_progress')
  const isLive = liveIndex >= 0
  const title = plan.title || 'Plan'
  const { count, percent } = bandCounts({ done, total })
  const palette = PALETTES[live.cfg.bandColor]
  const btnW = open > 0 ? `● ${open} for you`.length + 1 : 0
  const dismiss = (
    <Button key="plan-dismiss" plain onPress={() => void dismissBand($)}>
      <Text dimColor>✕</Text>
    </Button>
  )
  const note = bandNote(plan)
  const w = bodyColumns ?? 30
  let row: RenderElement
  if (surface !== 'terminal' && 'Svg' in els) {
    const Svg = (els as { Svg: unknown }).Svg as (p: { source: string; alt: string; width: number; height: number }) => RenderElement
    const px = bandWidthPx(bodyColumns, btnW + 3)
    row = (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Svg source={bandSvg({ title, done, total, isLive, liveIndex: Math.max(0, liveIndex) }, live.cfg.bandColor, px)} alt={`${title}: ${count}, ${percent}`} width={px} height={24} />
        {countBtn}
        {dismiss}
      </Box>
    )
  } else {
    const titleBox = Math.max(6, Math.min(28, Math.floor(w / 3), title.length))
    const barW = Math.max(6, w - titleBox - count.length - percent.length - 10 - btnW)
    const tick = await read($, shimmerAtom)
    const cells = planCells(live.cfg.barStyle, { done, total, isLive, barW, tick, palette })
    row = (
      <Box flexDirection="row" width={w}>
        <Text color={palette.deep}>● </Text>
        <Box width={titleBox} flexShrink={0}>
          <Text bold>{cut(title, titleBox)}</Text>
        </Box>
        <Text> </Text>
        {cellsEl(els, cells, 'band-bar')}
        <Text> </Text>
        <Text bold color={palette.mid}>
          {count}
        </Text>
        <Text dimColor>{` ${percent} `}</Text>
        {countBtn}
        {countBtn ? <Text> </Text> : null}
        {dismiss}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {lower}
      {row}
      {note ? <Text dimColor>{cut(note, w)}</Text> : null}
    </Box>
  )
}

// ---- Hooks ----

export const register: Register = (on, options) => {
  live.cfg = settings(options ?? {})
  live.rawPorts = typeof options?.ports === 'string' ? options.ports : undefined

  on('session.start', async ($, e, next) => {
    // (a) home and Windows
    const root = normPath($.plugin.root)
    const fromRoot = root.includes('/.claude/') ? root.slice(0, root.indexOf('/.claude/')) : root.slice(0, Math.max(0, root.lastIndexOf('/')))
    live.home = normPath((await envOf($.env.get('USERPROFILE'))) ?? (await envOf($.env.get('HOME'))) ?? fromRoot).replace(/\/+$/, '')
    live.windows = (await envOf($.env.get('OS'))) === 'Windows_NT'
    live.cwd = e.cwd

    // (b) the switches
    try {
      await checkSwitches($)
    } catch (err) {
      logError($, 'switches', err)
    }

    // (c) the task part
    try {
      await tasksOnSessionStart($)
    } catch (err) {
      logError($, 'tasks session.start', err)
    }

    // (e) the rest
    for (const problem of live.cfg.problems) debugLog($, `config: ${problem}`)
    try {
      await $.command.register({
        name: 'chat-sidecar',
        description: 'Show the Sidecar pane: to-do, subagents, background, connectors, files and skills; settings with "settings"',
        immediate: true,
      })
      await $.tool.register(PLAN_SPEC)
    } catch (err) {
      logError($, 'register', err)
    }

    if (!live.switchTimer) live.switchTimer = $.clock.every(SWITCH_MS, () => void checkSwitches($).catch(err => logError($, 'switches', err)))

    if (isShownSection('background')) {
      if (!live.bgTimer) {
        void scanBackground($)
        live.bgTimer = $.clock.every(live.cfg.pollMs, () => void scanBackground($))
      }
    } else {
      void read($, listenersAtom)
        .then(l => (l.length > 0 ? update($, listenersAtom, () => []) : undefined))
        .catch(() => undefined)
    }

    if (isShownSection('git')) {
      if (!live.gitTimer) {
        void refreshGit($)
        live.gitTimer = $.clock.every(GIT_MS, () => void refreshGit($))
      }
    } else {
      void read($, gitAtom)
        .then(g => (g !== null ? update($, gitAtom, () => null) : undefined))
        .catch(() => undefined)
    }

    try {
      // Cards after a reload: seats and colours go on after the restored ones.
      const cards = await read($, cardsAtom)
      if (cards.length > 0) {
        live.seat = Math.max(live.seat, ...cards.map(c => c.seat + 1))
        live.lastColor = Math.max(live.lastColor, ...cards.map(c => c.color))
      }
      syncCardTimers($)

      // (unverified) Whether /clear or a resume in the same process keeps $.state is not known: the seed is keyed by
      // session id, so a new id seeds again and adds its counts on top of the inventory kept (never reset here), while
      // `autoOpened` is a plain flag, so a kept state does not open the pane a second time.
      const sessionId = await $.session.id()
      const startedAt = await $.clock.now()
      if (!live.off && (await read($, seededAtom)) !== sessionId) {
        try {
          await seed($, sessionId, startedAt)
        } catch (err) {
          logError($, 'seed', err)
        }
        await update($, seededAtom, () => sessionId)
        const plan = await read($, planAtom)
        await planChanged($, plan)
      } else {
        // A reload: a fully done plan's band timer died with the old module.
        const plan = await read($, planAtom)
        live.bandStamp = plan.stamp
        if (isAllDone(plan) && (await read($, bandAtom)).shown) await update($, bandAtom, b => ({ ...b, shown: false }))
        syncShimmer($)
      }
      if (!live.off) await loadMemory($)
    } catch (err) {
      logError($, 'session.start', err)
    }

    // (d) opening by itself, not awaited. Kicked off last, just before next(e): it must land after session.start has
    // resolved (the kept tasks test checks no open right after start), and the rest of the start awaits many calls.
    if (e.isInteractive && !live.off && !live.hidden) {
      void (async () => {
        if (await read($, autoOpenedAtom)) return
        await update($, autoOpenedAtom, () => true)
        await openPane($, false)
      })().catch(err => logError($, 'open', err))
    }

    return next(e)
  })

  // The plan tool: answered here, nothing beneath runs.
  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    try {
      if (e.agentId) return { result: TEXT.planSubagent }
      if (live.off) return { result: TEXT.planOff }
      await changePlan($, p => applyPlanTool(p, inputOf(e)))
      return { result: TEXT.planSaved }
    } catch (err) {
      logError($, 'plan', err)
      return { result: TEXT.planError }
    }
  })

  // Every other tool call: subagent steps before, plan sources, connectors, files, skills and git after.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (live.off || tool === PLAN_TOOL || splitMcp(tool)?.server === PLUGIN) return next(e)
    const input = inputOf(e)
    const agentId = typeof e.agentId === 'string' ? e.agentId : undefined
    if (agentId) {
      try {
        await noteAgentCall($, agentId, tool, input)
      } catch (err) {
        logError($, 'subagent step', err)
      }
    }
    const result = await next(e)
    try {
      if (live.off || (result as { deny?: string }).deny) return result
      if (!agentId) await planFromBuiltin($, tool, input, (result as { result?: unknown }).result)
      const id = typeof input.tool_use_id === 'string' ? input.tool_use_id : undefined
      if (id === undefined || !live.counted.has(id)) {
        if (id !== undefined) live.counted.add(id)
        const now = await $.clock.now()
        const inv = await read($, inventoryAtom)
        const counted = countUse(inv, tool, input, now)
        if (counted !== inv) await update($, inventoryAtom, () => counted)
      }
      if (!agentId && tool === 'Bash' && typeof input.command === 'string' && /\bgit\s/.test(input.command)) void refreshGit($)
    } catch (err) {
      logError($, 'tool.call', err)
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      if (live.off || !result.agentId) return result
      const id = result.agentId
      const model = modelShort(e.model || result.model || '')
      const now = await $.clock.now()
      live.foreign.delete(id)
      await saveCards($, cards => {
        const old = cards.find(c => c.id === id)
        if (old) {
          return cards.map(c =>
            c.id === id ? { ...c, ...(e.description ? { description: e.description } : {}), ...(e.subagentType ? { type: e.subagentType } : {}), model: c.model || model } : c,
          )
        }
        return [...cards, newCard(id, e.description || 'Subagent', e.subagentType || 'subagent', model, now, cards)]
      })
    } catch (err) {
      logError($, 'agent.spawn', err)
    }
    return result
  })

  on('turn.step', async function* ($, e, next) {
    try {
      tasksOnTurnStep(e)
    } catch (err) {
      logError($, 'tasks turn.step', err)
    }
    const result = yield* next(e)
    try {
      if (e.agentId && !live.off && (await cardFor($, e.agentId))) {
        const id = e.agentId
        const model = e.model ? modelShort(e.model) : ''
        const effort = e.effort !== undefined ? String(e.effort) : ''
        const used = result?.usage ? usageTotal(result.usage) : 0
        await saveCards($, cards =>
          cards.map(c =>
            c.id === id
              ? { ...c, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(result?.usage ? { turnTokens: c.turnTokens + used, usageSeen: true } : {}) }
              : c,
          ),
        )
      }
    } catch (err) {
      logError($, 'turn.step', err)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      await tasksOnTurnComplete($, e)
    } catch (err) {
      logError($, 'tasks turn.complete', err)
    }
    try {
      const id = e.agentId
      if (id && !live.off && (await read($, cardsAtom)).some(c => c.id === id)) {
        const now = await $.clock.now()
        const failed = e.reason === 'error' || e.reason === 'refusal' || e.isAborted
        const usage = e.usage ?? result.usage
        await saveCards($, cards =>
          cards.map(c =>
            c.id === id
              ? {
                  ...c,
                  phase: failed ? 'failed' : 'done',
                  endMs: now,
                  tokens: c.tokens + (usage ? usageTotal(usage) : c.turnTokens),
                  turnTokens: 0,
                  usageSeen: c.usageSeen || usage !== undefined,
                }
              : c,
          ),
        )
      }
    } catch (err) {
      logError($, 'turn.complete', err)
    }
    return result
  })

  on('command.run', { command: 'chat-sidecar' }, async ($, e) => {
    if (live.off) return { text: TEXT.off }
    if (live.hidden) await unhide($)
    if (e.args.trim().toLowerCase() === 'settings') {
      await update($, screenAtom, s => ({ ...s, open: true }))
      await openPane($, false).catch(err => logError($, 'open', err))
      return { text: TEXT.openedSettings }
    }
    await openPane($, false).catch(err => logError($, 'open', err))
    await loadMemory($)
    return { text: TEXT.opened }
  })

  // Other slash commands: a skill the person typed counts as a use.
  on('command.run', async ($, e, next) => {
    const result = await next(e)
    if (!live.off && e.command !== 'chat-sidecar') {
      void isSkill($, e.command)
        .then(yes => (yes ? update($, inventoryAtom, inv => addSkill(inv, e.command)) : undefined))
        .catch(err => logError($, 'command', err))
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      tasksOnAbovePrompt($, e.props.isWorking)
    } catch (err) {
      logError($, 'tasks band', err)
    }
    if (live.off || e.props.hasSurvey || (await read($, offAtom))) return next(e)
    const els = $.ui.resolve(e)
    // Only the read decides whether anything is drawn; the hooks beneath are drawn above the band.
    const tasks = await read($, tasksAtom)
    const plan = await read($, planAtom)
    const band = await read($, bandAtom)
    const hidden = await read($, hiddenAtom)
    const hasPlan = !hidden && isShownSection('todo') && band.shown && plan.steps.length > 0
    if (!hasPlan && !tasks.some(t => t.state === 'open')) return next(e)
    const below = await next(e)
    try {
      return (await drawBand($, els, e.surface, e.props.bodyColumns, below)) ?? below
    } catch (err) {
      logError($, 'band', err)
      return below
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const els = $.ui.resolve(e)
    return drawPane($, els, e.surface, e.props.isFocused, e.props.bodyColumns)
  })

  registerTasks(on, options, { isOn: () => !live.off })
}

