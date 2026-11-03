// Pure helpers of the main module: bars, formatting, the plan, subagent steps and cards, Background ports, paths.
// `barParts` is used by the kept barstyle.ts.
import type { BandState, Card, ConnectorCall, ConnectorRow, FileRow, HelperPhase, Inventory, Listener, Plan, PlanStatus, PlanStep, SkillRow, Step, StepKind } from '../types'
import { cut, flat, splitMcp, stepWords } from './connectors'

export { cut, flat }

// ---- Bars ----

/**
 * A subagent card's bar, `w` cells of `░`/`█`: a piece of max(3, floor(w/4)) cells slides left to right while it
 * works and re-enters from the left, offset by `seat` so cards do not move in lockstep; full once it is over.
 */
export function barParts(phase: HelperPhase, w: number, tick: number, seat: number): [string, string, string] {
  const width = Math.max(0, Math.floor(w))
  if (phase !== 'working') return ['', '█'.repeat(width), '']
  const p = Math.max(3, Math.floor(width / 4))
  const span = width + p
  const h = (((tick + 5 * seat + p) % span) + span) % span - p
  const from = Math.max(0, h)
  const to = Math.min(width, h + p)
  const piece = Math.max(0, to - from)
  const before = Math.min(width, from)
  return ['░'.repeat(before), '█'.repeat(piece), '░'.repeat(Math.max(0, width - before - piece))]
}

// ---- Formatting ----

/** `m:ss` under an hour, `h:mm:ss` from an hour; whole seconds, floored, never negative. */
export function elapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** `999`, `34k`, `1.2M`. */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** `claude-opus-5-5` -> `Opus 5.5`, `haiku` -> `Haiku`; no family word: unchanged. */
export function modelShort(model: string): string {
  const m = /(opus|sonnet|haiku|fable)(?:[-_ .](\d+)(?:[-_ .](\d+))?)?/i.exec(model)
  if (!m) return model
  const family = m[1]!.toLowerCase()
  return `${family[0]!.toUpperCase()}${family.slice(1)}${m[2] ? ` ${m[2]}` : ''}${m[2] && m[3] ? `.${m[3]}` : ''}`
}

/** input + output + cache-read + cache-creation tokens. */
export function usageTotal(u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null | undefined): number {
  if (!u) return 0
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

/** `n word` or `n words`. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * Text wrapped to `width` (at least 8): breaks at spaces, a word longer than the line is hard-split.
 */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(8, Math.floor(width))
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const raw of para.split(' ')) {
      let word = raw
      while (word.length > w) {
        if (line) {
          lines.push(line)
          line = ''
        }
        lines.push(word.slice(0, w))
        word = word.slice(w)
      }
      if (!line) line = word
      else if (line.length + 1 + word.length <= w) line += ` ${word}`
      else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  return lines
}

// ---- Paths ----

/** Forward slashes. */
export function normPath(p: string): string {
  return p.replace(/\\/g, '/')
}

/** A path under the home folder as `~` + the rest (case-insensitive on a Windows drive path). */
export function homeShort(path: string, home: string): string {
  const p = normPath(path)
  const h = normPath(home).replace(/\/+$/, '')
  if (!h) return p
  const isWin = /^[a-z]:\//i.test(h)
  const starts = isWin ? p.toLowerCase().startsWith(h.toLowerCase()) : p.startsWith(h)
  if (starts && (p.length === h.length || p[h.length] === '/')) return `~${p.slice(h.length)}`
  return p
}

export function fileName(path: string): string {
  const p = normPath(path).replace(/\/+$/, '')
  return p.split('/').pop() || p
}

export function folderOf(path: string): string {
  const p = normPath(path)
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : i === 0 ? '/' : p.slice(0, i)
}

/** The folder of a context file as a row shows it: home-shortened, `/` at the root, `…/<last>` when long. */
export function shownFolder(path: string, home: string): string {
  const folder = folderOf(normPath(path))
  if (folder === '' || folder === '/') return '/'
  const short = homeShort(folder, home)
  const segments = short.split('/').filter(Boolean)
  if (short.length > 28 && segments.length > 1) return `…/${segments.at(-1)}`
  return short
}

/** The skill a `.../<folder>/SKILL.md` path stands for, else undefined. */
export function skillOfPath(path: string): string | undefined {
  return /\/([^/]+)\/SKILL\.md$/.exec(normPath(path))?.[1]
}

/** The engine's spill files: tool results, temp files, a session's own folder under ~/.claude/projects. */
export function isSpill(path: string, home: string): boolean {
  const p = normPath(path)
  if (p.includes('/tool-results/') || p.startsWith('/tmp/') || p.startsWith('/private/tmp/')) return true
  const h = normPath(home).replace(/\/+$/, '')
  const projects = `${h}/.claude/projects/`
  const rest = p.toLowerCase().startsWith(projects.toLowerCase()) ? p.slice(projects.length) : undefined
  return rest !== undefined && /^[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i.test(rest)
}

/** This chat's transcript file: `~/.claude/projects/<cwd, non-alphanumerics as '-'>/<session>.jsonl`. */
export function transcriptPath(home: string, cwd: string, sessionId: string): string {
  return `${normPath(home).replace(/\/+$/, '')}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`
}

/** Tool-use id -> timestamp (ms) from a transcript's lines. */
export function transcriptTimes(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of text.split('\n')) {
    if (!line.includes('tool_use')) continue
    try {
      const row = JSON.parse(line) as { timestamp?: string; message?: { content?: unknown } }
      const at = row.timestamp ? Date.parse(row.timestamp) : NaN
      if (!Number.isFinite(at)) continue
      const content = row.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content as { type?: string; id?: string }[]) {
        if (block?.type === 'tool_use' && typeof block.id === 'string') out.set(block.id, at)
      }
    } catch {
      // a line that is not JSON is skipped
    }
  }
  return out
}

/** `HH:MM`, local time; blank when unknown. */
export function clockOf(ms: number | null | undefined, offsetMinutes = new Date().getTimezoneOffset()): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return ''
  const d = new Date(ms - offsetMinutes * 60_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

// ---- The plan ----

const STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'completed']
const statusOf = (s: unknown): PlanStatus => (STATUSES.includes(s as PlanStatus) ? (s as PlanStatus) : 'pending')
const textOf = (s: unknown) => (typeof s === 'string' ? s.trim() : '')

export const EMPTY_PLAN: Plan = { title: '', steps: [], stamp: 0 }

/** `mcp__chat-sidecar__plan`: all steps replaced; the title too when given. */
export function applyPlanTool(plan: Plan, input: Readonly<Record<string, unknown>>): Plan {
  const raw = Array.isArray(input.steps) ? (input.steps as Record<string, unknown>[]) : []
  const steps = raw.filter(s => s && textOf(s.text)).map((s): PlanStep => ({ text: textOf(s.text), status: statusOf(s.status) }))
  return { ...plan, title: typeof input.title === 'string' ? input.title.trim() : plan.title, steps }
}

/** TodoWrite: all steps replaced, the title kept. */
export function applyTodoWrite(plan: Plan, input: Readonly<Record<string, unknown>>): Plan {
  const raw = Array.isArray(input.todos) ? (input.todos as Record<string, unknown>[]) : []
  const steps = raw
    .filter(t => t && textOf(t.content))
    .map((t): PlanStep => ({ text: textOf(t.content), status: statusOf(t.status), ...(textOf(t.activeForm) ? { activeForm: textOf(t.activeForm) } : {}) }))
  return { ...plan, steps }
}

/** The id TaskCreate's result gives the new task (unverified shape: `{ task: { id } }`, `{ id }`, or `#id` in text). */
export function createdId(result: unknown): string | undefined {
  if (result && typeof result === 'object') {
    const r = result as { task?: { id?: unknown }; id?: unknown; taskId?: unknown }
    const id = r.task?.id ?? r.id ?? r.taskId
    if (typeof id === 'string' || typeof id === 'number') return String(id)
  }
  if (typeof result === 'string') return /#(\d+)/.exec(result)?.[1] ?? /\b(\d+)\b/.exec(result)?.[1]
  return undefined
}

/** TaskCreate: a pending step appended, its id the created task's, or its 1-based position. */
export function applyTaskCreate(plan: Plan, input: Readonly<Record<string, unknown>>, id?: string): Plan | null {
  const text = textOf(input.subject)
  if (!text) return null
  const step: PlanStep = { text, status: 'pending', id: id ?? String(plan.steps.length + 1), ...(textOf(input.activeForm) ? { activeForm: textOf(input.activeForm) } : {}) }
  return { ...plan, steps: [...plan.steps, step] }
}

/** TaskUpdate: the step by id (a number is a position when no step has an id); `deleted` removes it. */
export function applyTaskUpdate(plan: Plan, input: Readonly<Record<string, unknown>>): Plan | null {
  const id = input.taskId
  if (typeof id !== 'string' && typeof id !== 'number') return null
  let i = plan.steps.findIndex(s => s.id !== undefined && s.id === String(id))
  if (i < 0 && !plan.steps.some(s => s.id !== undefined) && /^\d+$/.test(String(id))) i = Number(id) - 1
  const step = plan.steps[i]
  if (!step) return null
  if (input.status === 'deleted') return { ...plan, steps: plan.steps.filter((_, j) => j !== i) }
  const next: PlanStep = {
    ...step,
    ...(textOf(input.subject) ? { text: textOf(input.subject) } : {}),
    ...(textOf(input.activeForm) ? { activeForm: textOf(input.activeForm) } : {}),
    ...(input.status !== undefined ? { status: statusOf(input.status) } : {}),
  }
  return { ...plan, steps: plan.steps.map((s, j) => (j === i ? next : s)) }
}

export function planDone(plan: Pick<Plan, 'steps'>): number {
  return plan.steps.filter(s => s.status === 'completed').length
}

export function isAllDone(plan: Pick<Plan, 'steps'>): boolean {
  return plan.steps.length > 0 && plan.steps.every(s => s.status === 'completed')
}

/** The band's second line: `Now: ...`, `All steps done`, or `Next: ...`. */
export function bandNote(plan: Pick<Plan, 'steps'>): string {
  const live = plan.steps.find(s => s.status === 'in_progress')
  if (live) return `Now: ${live.activeForm || live.text}`
  if (isAllDone(plan)) return 'All steps done'
  const next = plan.steps.find(s => s.status === 'pending')
  return next ? `Next: ${next.text}` : ''
}

export type BandChange = { band: BandState; timer: 'start' | 'cancel' | 'keep' }

/** The band's "shown" flag after the plan's stamp changed. */
export function nextBand(prev: BandState, plan: Plan): BandChange {
  if (plan.steps.length === 0) return { band: { shown: false, allDone: false, stamp: plan.stamp }, timer: 'cancel' }
  const allDone = isAllDone(plan)
  if (allDone && prev.allDone) return { band: { ...prev, stamp: plan.stamp }, timer: 'keep' }
  if (allDone) return { band: { shown: true, allDone: true, stamp: plan.stamp }, timer: 'start' }
  return { band: { shown: true, allDone: false, stamp: plan.stamp }, timer: 'cancel' }
}

// ---- Subagent steps ----

export const KIND_NAMES: Record<StepKind, string> = {
  read: 'File read',
  write: 'File write',
  command: 'Command',
  web: 'Web',
  skill: 'Skill',
  subagent: 'Subagent',
  connector: 'Connector',
  tool: 'Tool',
}

const arg = (input: Readonly<Record<string, unknown>>, key: string) => (typeof input[key] === 'string' ? flat(input[key] as string) : '')

/** A tool call as a subagent card's step. `nameOf` names an MCP server for a tool. */
export function stepOf(tool: string, input: Readonly<Record<string, unknown>>, home: string, nameOf: (server: string, tool: string) => string): Step {
  const fileStep = (kind: StepKind, key: string, verb: string): Step => {
    const p = arg(input, key)
    const name = p ? fileName(p) : 'a file'
    const folder = p ? folderOf(normPath(p)) : ''
    return { kind, label: name, ...(folder ? { dim: homeShort(folder, home) } : {}), live: `${verb} ${name}` }
  }
  switch (tool) {
    case 'Read':
      return fileStep('read', 'file_path', 'Reading')
    case 'Write':
      return fileStep('write', 'file_path', 'Writing')
    case 'Edit':
    case 'MultiEdit':
      return fileStep('write', 'file_path', 'Editing')
    case 'NotebookEdit':
      return fileStep('write', 'notebook_path', 'Editing')
    case 'Grep':
    case 'Glob': {
      const pattern = arg(input, 'pattern')
      const path = arg(input, 'path')
      return {
        kind: 'read',
        label: pattern ? `Search "${cut(pattern, 60)}"` : 'Search files',
        ...(path ? { dim: homeShort(path, home) } : {}),
        live: pattern ? `Searching files for "${cut(pattern, 40)}"` : 'Searching files',
      }
    }
    case 'Bash': {
      const label = arg(input, 'description') || (arg(input, 'command') ? cut(arg(input, 'command'), 80) : 'a command')
      return { kind: 'command', label, live: `Running: ${label}` }
    }
    case 'WebSearch': {
      const q = arg(input, 'query')
      return { kind: 'web', label: q || 'web search', live: `Searching the web: ${q || 'web search'}` }
    }
    case 'WebFetch': {
      let host = 'a web page'
      try {
        host = new URL(arg(input, 'url')).host || host
      } catch {
        // not a URL
      }
      return { kind: 'web', label: host, live: `Opening ${host}` }
    }
    case 'Skill': {
      const name = arg(input, 'skill').replace(/^\//, '') || 'a skill'
      return { kind: 'skill', label: name, live: `Using the ${name} skill` }
    }
    case 'Agent':
    case 'Task': {
      const d = arg(input, 'description')
      return { kind: 'subagent', label: d || 'Start a subagent', live: d ? `Starting a subagent: ${d}` : 'Starting a subagent' }
    }
    case 'SendMessage':
      return { kind: 'subagent', label: 'Send a message', live: 'Sending a message' }
    case 'TodoWrite':
      return { kind: 'tool', label: 'Update its to-do list', live: 'Updating its to-do list' }
    case 'ToolSearch':
      return { kind: 'tool', label: 'Load tools', live: 'Loading tools' }
  }
  const mcp = splitMcp(tool)
  if (mcp) {
    const name = nameOf(mcp.server, mcp.tool)
    const words = stepWords(mcp.tool, name)
    return { kind: 'connector', label: `${name} · ${words}`, live: `${name}: ${words}` }
  }
  return { kind: 'tool', label: tool, live: `Using ${tool}` }
}

// ---- Subagent cards ----

export const CARD_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const
export const CARD_HEX: Record<(typeof CARD_COLORS)[number], string> = {
  red: '#e5484d',
  orange: '#f76b15',
  yellow: '#e2b203',
  green: '#30a46c',
  teal: '#12a594',
  blue: '#3e63dd',
  purple: '#8e4ec6',
  pink: '#d6409f',
}
export const MAX_STEPS = 200
export const MAX_FINISHED = 30

/** The next colour after `last`, skipping those worn by running cards (unless all 8 are). */
export function pickColor(last: number, running: readonly number[]): number {
  const n = CARD_COLORS.length
  for (let k = 1; k <= n; k++) {
    const c = (((last + k) % n) + n) % n
    if (!running.includes(c)) return c
  }
  return (((last + 1) % n) + n) % n
}

/** At most MAX_FINISHED cards that are over: the oldest dropped. Running cards stay. */
export function pruneCards(cards: readonly Card[]): Card[] {
  const over = cards.filter(c => c.phase !== 'working')
  const drop = new Set(over.slice(0, Math.max(0, over.length - MAX_FINISHED)).map(c => c.id))
  return cards.filter(c => !drop.has(c.id))
}

/**
 * Whether an agent whose turn ended still works: it waits on background work it owns, or (not ended) a card it
 * spawned is working. An orchestrator ends a turn after each spawn and wakes when a child hands back.
 */
export function isHeld(id: string, status: string | undefined, cards: readonly Card[]): boolean {
  if (status === undefined || status === 'completed' || status === 'failed' || status === 'killed') return false
  return status === 'waiting' || cards.some(c => c.parentId === id && c.phase === 'working')
}

/** A step appended (newest MAX_STEPS kept), the call counted, a card that was over working again. */
export function withStep(card: Card, step: Step): Card {
  const steps = [...card.steps, step]
  const { endMs: _ended, ...rest } = card
  return { ...rest, phase: 'working', calls: card.calls + 1, steps: steps.length > MAX_STEPS ? steps.slice(-MAX_STEPS) : steps }
}

// ---- Background ----

export type PortState = 'idle' | 'up' | 'foreign'
export type PortChip = { port: number; state: PortState; entry?: Listener }
export type PortGroup = { label: string; ports: PortChip[] }

/** An image the scan could not tell (`?`), or java, javaw, node (with or without `.exe`). */
export function isOwnImage(image: string): boolean {
  return image === '?' || /^(java|javaw|node)(\.exe)?$/i.test(image)
}

/** One group per label, ordered by their lowest port, ports ascending, each idle, up or foreign. */
export function portGroups(watched: Readonly<Record<number, string>>, entries: readonly Listener[]): PortGroup[] {
  const groups = new Map<string, PortChip[]>()
  const ports = Object.keys(watched)
    .map(Number)
    .sort((a, b) => a - b)
  for (const port of ports) {
    const label = watched[port]!
    const entry = entries.find(e => e.port === port)
    const chip: PortChip = entry ? { port, state: isOwnImage(entry.image) ? 'up' : 'foreign', entry } : { port, state: 'idle' }
    groups.set(label, [...(groups.get(label) ?? []), chip])
  }
  return [...groups].map(([label, chips]) => ({ label, ports: chips }))
}

/** `backend :8090`, `backend tests (surefire) ×3 412/924`, `vitest ×2 40`. Not used by the pane drawing. */
export function backgroundLine(l: Pick<Listener, 'label' | 'port' | 'count' | 'progress'>): string {
  let s = l.label
  if (l.port) s += ` :${l.port}`
  if (l.count > 1) s += ` ×${l.count}`
  if (l.progress) s += l.progress.total !== undefined && l.progress.done <= l.progress.total ? ` ${l.progress.done}/${l.progress.total}` : ` ${l.progress.done}`
  return s
}

/** An image without a trailing `.exe`. */
export function bareImage(image: string): string {
  return image.replace(/\.exe$/i, '')
}

// ---- Switches ----

/** switches.json's two keys: off is exactly `"chat-sidecar": false`, hidden exactly `"chat-sidecar:hidden": true`. */
export function switchesOf(raw: unknown): { off: boolean; hidden: boolean } {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return { off: o['chat-sidecar'] === false, hidden: o['chat-sidecar:hidden'] === true }
}

/** The settings screen's ports check: the bad entries, or none. */
export function badPorts(text: string): string[] {
  return text
    .split(/[,;\s]+/)
    .filter(Boolean)
    .filter(t => {
      const m = /^(\d{1,5})=(\S+)$/.exec(t)
      const port = Number(m?.[1])
      return !(m && port >= 1 && port <= 65535)
    })
}

// ---- Inventory: connectors, context files, skills ----

export const EMPTY_INVENTORY: Inventory = { connectors: [], files: [], skills: [] }
export const MAX_CALLS = 60

/** One above the highest order in the inventory. */
export function nextOrder(inv: Inventory): number {
  let max = 0
  for (const r of [...inv.connectors, ...inv.files, ...inv.skills]) max = Math.max(max, r.order)
  return max + 1
}

/** A call added to its connector's row (rows merge by key; the newest 60 calls kept). */
export function addConnectorCall(inv: Inventory, key: string, name: string, call: ConnectorCall): Inventory {
  const order = nextOrder(inv)
  const old = inv.connectors.find(r => r.key === key)
  const calls = [...(old?.calls ?? []), call].slice(-MAX_CALLS)
  const row: ConnectorRow = {
    key,
    name: old?.name ?? name,
    count: (old?.count ?? 0) + 1,
    order,
    cli: (old?.cli ?? false) || call.cli,
    mcp: (old?.mcp ?? false) || !call.cli,
    calls,
  }
  return { ...inv, connectors: [...inv.connectors.filter(r => r.key !== key), row] }
}

/** A file read: a new row, or the existing one moved to the top. */
export function addFile(inv: Inventory, path: string): Inventory {
  const order = nextOrder(inv)
  const old = inv.files.find(f => f.path === path)
  const row: FileRow = { path, order, auto: old?.auto ?? false }
  return { ...inv, files: [...inv.files.filter(f => f.path !== path), row] }
}

/** Memory files loaded at start: SKILL.md paths become always-loaded skills, the rest `auto` file rows. */
export function addMemoryFiles(inv: Inventory, paths: readonly string[]): Inventory {
  let out = inv
  for (const raw of paths) {
    const path = normPath(raw)
    const skill = skillOfPath(path)
    if (skill !== undefined) {
      out = markAlways(out, skill)
      continue
    }
    const old = out.files.find(f => f.path === path)
    out = old
      ? { ...out, files: out.files.map(f => (f.path === path ? { ...f, auto: true } : f)) }
      : { ...out, files: [...out.files, { path, order: nextOrder(out), auto: true }] }
  }
  return { ...out, files: out.files.filter(f => skillOfPath(f.path) === undefined) }
}

/** One use of a skill. */
export function addSkill(inv: Inventory, name: string): Inventory {
  const order = nextOrder(inv)
  const old = inv.skills.find(s => s.name === name)
  const row: SkillRow = { name, count: (old?.count ?? 0) + 1, order, always: old?.always ?? false }
  return { ...inv, skills: [...inv.skills.filter(s => s.name !== name), row] }
}

/** A skill always loaded; its count and order unchanged. */
export function markAlways(inv: Inventory, name: string): Inventory {
  const old = inv.skills.find(s => s.name === name)
  if (old) return old.always ? inv : { ...inv, skills: inv.skills.map(s => (s.name === name ? { ...s, always: true } : s)) }
  return { ...inv, skills: [...inv.skills, { name, count: 0, order: 0, always: true }] }
}

/** Connectors by last use, newest first. */
export function connectorsShown(inv: Inventory): ConnectorRow[] {
  return [...inv.connectors].sort((a, b) => b.order - a.order)
}

/** Files read (latest on top), then memory files (in reverse load order). */
export function filesShown(inv: Inventory): FileRow[] {
  const by = (a: FileRow, b: FileRow) => b.order - a.order
  return [...inv.files.filter(f => !f.auto).sort(by), ...inv.files.filter(f => f.auto).sort(by)]
}

/** Used skills by last use, then always-loaded skills never used. */
export function skillsShown(inv: Inventory): SkillRow[] {
  const by = (a: SkillRow, b: SkillRow) => b.order - a.order
  return [...inv.skills.filter(s => s.count > 0).sort(by), ...inv.skills.filter(s => s.count === 0).sort(by)]
}

export const FILES_WINDOW = 10
export const FILES_STEP = 5

/** The first visible Context files row, clamped to the list. */
export function clampTop(top: number, count: number): number {
  return Math.max(0, Math.min(top, count - FILES_WINDOW))
}
