// The main module's acceptance tests (SPEC.md parts 1, 2 and 3). Each test names the items it covers as P<part>#<n>.
import type { On, PaneOpenArgs } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { LOGOS } from './logos'

const HOME = '/home/me'
const SWITCHES = `${HOME}/.claude/mods/switches.json`
const ASSIGN = 'mcp__chat-sidecar__assign_task'
const WITHDRAW = 'mcp__chat-sidecar__withdraw_task'
const PLAN = 'mcp__chat-sidecar__plan'
const NOW = 1_000_000

/** Every section but the ones named, off. */
function only(...ids: string[]) {
  const all = ['todo', 'tasks', 'subagents', 'background', 'connectors', 'files', 'skills', 'git']
  const field = (id: string) => `show${{ todo: 'Todo', tasks: 'Tasks', subagents: 'Subagents', background: 'Background', connectors: 'Connectors', files: 'Files', skills: 'Skills', git: 'Git' }[id]}`
  return Object.fromEntries(all.map(id => [field(id), ids.includes(id)]))
}

/**
 * A path as the rig keys its files: forward slashes, no drive letter. The engine resolves a path that is not absolute
 * on the host (`/home/me` on Windows) against a drive or the plugin folder, so the rig never compares raw spellings.
 */
function norm(path: string): string {
  return path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
}

type Row = { key: string; label: string; kind: string; value: unknown; provider: unknown; isLocked: boolean }

/** The engine beneath the plugin: files, env, a store, a session, panes, config rows, agents and processes. */
function seat(on: On, opts: { windows?: boolean; env?: Record<string, string>; store?: Record<string, unknown> } = {}) {
  const world = {
    files: {} as Record<string, string>,
    dirs: {} as Record<string, { name: string; kind: 'file'; size: number; mtimeMs: number }[]>,
    opens: [] as PaneOpenArgs[],
    closes: [] as string[],
    toasts: [] as string[],
    isNarrow: false,
    sessionId: 'session-1',
    rows: [] as Row[],
    sets: [] as { key: string; value: unknown }[],
    agents: [] as { id: string; description: string; type: string; status: string }[],
    agentLists: 0,
    runs: [] as string[][],
    /** Answers a process run: stdout, or null for a failure (exit 1). */
    proc: (_argv: readonly string[]): string | null => null,
    messages: [] as unknown[],
    subMessages: {} as Record<string, unknown[]>,
    memoryFiles: [] as { path: string; type: string; tokens: number }[],
    skills: [] as { name: string; source: string; tokens: number }[],
    commands: [] as { name: string; description: string; source: string }[],
    panesAsked: 0,
    /** Names the agent a spawn starts. */
    spawnId: (e: { description: string }) => `agent-${e.description.length}`,
    /** Every value the plugin wrote to `isWorking`. */
    working: [] as unknown[],
  }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, opts.store)
  // Every variable the module reads is set here, so the host's own (USERPROFILE, OS on Windows) never leaks in.
  mock.env(on, { HOME, USERPROFILE: HOME, OS: opts.windows ? 'Windows_NT' : 'Linux', ...opts.env })

  on('fs.exists', ($, e) => ({ value: norm(e.path) in world.files || norm(e.path) in world.dirs }))
  on('fs.read', ($, e) => {
    if (!(norm(e.path) in world.files)) throw new Error(`ENOENT ${e.path}`)
    return { value: world.files[norm(e.path)]! } as never
  })
  on('fs.write', ($, e) => {
    world.files[norm(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    if (!(norm(e.path) in world.dirs)) throw new Error(`ENOENT ${e.path}`)
    return { value: world.dirs[norm(e.path)]! } as never
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    world.opens.push(e)
    return { value: e.focus === true || !world.isNarrow ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }
  })
  on('ui.close', ($, e) => {
    world.closes.push(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => {
    world.panesAsked += 1
    return { value: [] }
  })
  on('ui.focus', () => ({}))
  on('session.id', () => ({ value: world.sessionId }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.messages', ($, e) => ({ value: (e as { agentId?: string }).agentId ? (world.subMessages[(e as { agentId: string }).agentId] ?? []) : world.messages }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 1, breakdown: { memoryFiles: world.memoryFiles, skills: { totalSkills: 0, includedSkills: 0, tokens: 0, skillFrontmatter: world.skills } } } } }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__chat-sidecar__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: world.commands }) as never)
  on('command.run', () => ({}))
  on('config.list', () => ({ value: world.rows }) as never)
  on('config.set', ($, e) => {
    world.sets.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('agent.list', () => {
    world.agentLists += 1
    return { value: world.agents } as never
  })
  on('agent.spawn', ($, e) => ({ agentId: world.spawnId(e), model: 'claude-haiku-5-5' }))
  on('state.set', { plugin: 'chat-sidecar', key: 'isWorking' }, async ($, e, next) => {
    world.working.push((e as { value: unknown }).value)
    return next(e)
  })
  on('process.run', ($, e) => {
    world.runs.push([...e.argv])
    const out = world.proc(e.argv)
    return { value: out === null ? { exitCode: 1, stdout: '', stderr: 'no' } : { exitCode: 0, stdout: out, stderr: '' } } as never
  })
  on('tool.call', ($, e) => ({ result: `ran ${String(e.tool)}` }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  } as never)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })

  const setSwitches = (value: unknown) => {
    world.files[SWITCHES] = JSON.stringify(value)
  }
  return { world, clock, setSwitches }
}

async function start($: Engine, isInteractive = true) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive })
}

const pane = <S extends 'terminal' | 'desktop' | 'mobile' = 'terminal'>(surface: S = 'terminal' as S, bodyColumns = 80) =>
  ({
    plugin: 'chat-sidecar',
    surface,
    component: 'Pane',
    requestId: 'chat-sidecar',
    props: { title: 'Sidecar', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  }) as const

const band = (surface: 'terminal' | 'desktop' = 'terminal', bodyColumns = 60, isWorking = false) =>
  ({
    plugin: 'chat-sidecar',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 4, bodyColumns, scroll: { offset: 0, bodyRows: 4 }, view: {} },
  }) as const

const command = ($: Engine, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)

/** Every text of the drawing, one per line. */
async function textsOf(ui: { findAll: (q: { type?: string }) => Promise<{ text: string }[]> }): Promise<string[]> {
  return [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))].map(t => t.text)
}

async function allText(ui: { drawn: () => Promise<unknown>; findAll: (q: { type?: string }) => Promise<{ text: string }[]> }): Promise<string> {
  return (await textsOf(ui)).join('\n')
}

const TASK = { tool: ASSIGN, title: 'Add the API key to .env', why: 'The test needs it.', kind: 'do' } as const
const TASK2 = { tool: ASSIGN, title: 'Approve the migration plan', why: 'It is your call.', kind: 'do' } as const

// =====================================================================================================================
// Part 1: pane frame, settings, plan band, To-do
// =====================================================================================================================

test('P1#1 P3#15: an interactive start opens the pane once, without focus; a reload start does not; non-interactive never', async ($, on) => {
  const { world, clock } = seat(on)
  await start($)
  await clock.settle()
  expect(world.opens).toEqual([{ id: 'chat-sidecar', title: 'Sidecar' }])
  await start($)
  await clock.settle()
  expect(world.opens).toHaveLength(1)
})

test('P1#1: a non-interactive start opens nothing', async ($, on) => {
  const { world, clock } = seat(on)
  await start($, false)
  await clock.settle()
  expect(world.opens).toHaveLength(0)
})

test('P1#2 P3#16: assigned tasks open only the sidecar, without focus and with no host toast; the top row reads Sidecar', async ($, on) => {
  const { world, clock } = seat(on)
  await start($)
  await clock.settle()
  await $.tool.call(TASK)
  await $.tool.call(TASK2)
  expect(world.opens.every(o => o.id === 'chat-sidecar')).toBe(true)
  expect(world.opens.at(-1)?.focus).toBeUndefined()
  expect(world.toasts).toEqual([])
  const ui = await $.ui.mount(pane())
  expect((await ui.find({ key: 'title' }))?.text).toBe('Sidecar')
})

test('P1#3 P2#6: off in switches.json: nothing opens or is counted, /chat-sidecar says so, the pane draws only the off line', async ($, on) => {
  const { world, clock, setSwitches } = seat(on)
  setSwitches({ 'chat-sidecar': false })
  await start($)
  await clock.settle()
  await $.tool.call({ tool: 'mcp__1a2b3c4d-0000__search_threads', query: 'x' } as never)
  await $.tool.call({ tool: 'Skill', skill: 'video-prep' } as never)
  expect(world.opens).toHaveLength(0)
  expect((await command($, 'chat-sidecar')).text).toContain('Chat sidecar is off')
  expect(world.opens).toHaveLength(0)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    const text = await allText(ui)
    expect(text).toContain('Turned off in ~/.claude/mods/switches.json ("chat-sidecar": false).')
    for (const word of ['To-do', 'Connectors', 'Gmail', 'Skills', 'Subagents']) expect(text).not.toContain(word)
    await ui.unmount()
  }
  // the band draws nothing of its own, the plan tool saves nothing
  expect(String(((await $.tool.call({ tool: PLAN, steps: [{ text: 'a', status: 'pending' }] } as never)) as { result?: unknown }).result)).toBe(
    'The chat sidecar is off, so the plan is not shown.',
  )
  const b = await $.ui.mount(band())
  expect(await b.find({ key: 'band-tasks' })).toBeUndefined()
  expect(await b.find({ key: 'engine' })).toBeDefined()
})

test('the home folder is USERPROFILE before HOME (Windows), backslashes as slashes', { options: only() }, async ($, on) => {
  const { world, clock } = seat(on, { windows: true, env: { USERPROFILE: '\\Users\\me', HOME: '/elsewhere' } })
  world.files['/Users/me/.claude/mods/switches.json'] = JSON.stringify({ 'chat-sidecar': false })
  await start($)
  await clock.settle()
  expect((await command($, 'chat-sidecar')).text).toContain('Chat sidecar is off')
  expect(world.opens).toEqual([])
})

test('P1#4: Hide writes exactly the hidden key, closes the pane, toasts, and later activity does not open it', async ($, on) => {
  const { world, clock } = seat(on)
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'pane-hide' })
  expect(JSON.parse(world.files[SWITCHES]!)).toEqual({ 'chat-sidecar:hidden': true })
  expect(world.files[SWITCHES]).toBe('{\n  "chat-sidecar:hidden": true\n}\n')
  expect(world.opens).toHaveLength(1)
  expect(world.closes).toContain('chat-sidecar')
  expect(world.toasts).toEqual(['Chat sidecar hidden. Type /chat-sidecar to show it again.'])
  await $.tool.call(TASK)
  await clock.advance(4000)
  expect(world.opens).toHaveLength(1)
})

test('P1#5: hidden at start, the pane does not open; /chat-sidecar removes the key and opens it', async ($, on) => {
  const { world, clock, setSwitches } = seat(on)
  setSwitches({ 'chat-sidecar:hidden': true, other: 1 })
  await start($)
  await clock.settle()
  expect(world.opens).toHaveLength(0)
  expect((await command($, 'chat-sidecar')).text).toBe('Opened the Sidecar pane.')
  expect(JSON.parse(world.files[SWITCHES]!)).toEqual({ other: 1 })
  expect(world.opens.map(o => o.id)).toEqual(['chat-sidecar'])
})

test('P1#6: hidden with Hide, /chat-sidecar opens only the sidecar; hidden again, /my-tasks opens it too', async ($, on) => {
  const { world, clock } = seat(on)
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'pane-hide' })
  await command($, 'chat-sidecar')
  expect(world.opens.map(o => o.id)).toEqual(['chat-sidecar', 'chat-sidecar'])
  await ui.press({ key: 'pane-hide' })
  await command($, 'my-tasks')
  expect(world.opens).toHaveLength(3)
  expect(world.opens.every(o => o.id === 'chat-sidecar')).toBe(true)
})

test('P1#7: every header starts open; pressing Context files folds only it, pressing again unfolds', async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  await $.tool.call({ tool: 'Read', file_path: '/repo/notes.md' } as never)
  await $.tool.call({ tool: 'Skill', skill: 'video-prep' } as never)
  const ui = await $.ui.mount(pane())
  const headers = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('sec-'))
  expect(headers.length).toBeGreaterThan(3)
  expect(headers.every(h => h.text.startsWith('▾ '))).toBe(true)
  await ui.press({ key: 'sec-files' })
  expect((await ui.find({ key: 'sec-files' }))?.text).toBe('▸ Context files')
  expect(await allText(ui)).not.toContain('notes.md')
  expect(await allText(ui)).toContain('video-prep')
  await ui.press({ key: 'sec-files' })
  expect(await allText(ui)).toContain('notes.md')
})

test('P1#8: a TodoWrite draws its steps: marks, count, the done one struck through, the active form bold', async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read the spec', status: 'completed', activeForm: 'Reading the spec' },
      { content: 'Write the code', status: 'in_progress', activeForm: 'Writing the code' },
      { content: 'Test it', status: 'pending', activeForm: 'Testing it' },
    ],
  } as never)
  const ui = await $.ui.mount(pane())
  expect((await ui.find({ key: 'sec-todo' }))?.text).toBe('▾ To-do')
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.some(t => t.text === '1 of 3')).toBe(true)
  expect(texts.filter(t => t.text === '✓')).toHaveLength(1)
  expect(texts.filter(t => t.text === '●')).toHaveLength(1)
  expect(texts.filter(t => t.text === '○')).toHaveLength(1)
  const done = texts.find(t => t.text === 'Read the spec')
  expect([done?.props.dimColor, done?.props.strikethrough]).toEqual([true, true])
  expect(texts.find(t => t.text === 'Writing the code')?.props.bold).toBe(true)
  expect(texts.some(t => t.text.startsWith('No to-do list yet.'))).toBe(false)
})

test('P1#9: the plan tool saves from the main chat, refuses a subagent, and is never a connector', async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  const saved = await $.tool.call({ tool: PLAN, title: 'Ship', steps: [{ text: 'a', status: 'pending' }, { text: 'b', status: 'pending' }] } as never)
  expect(String((saved as { result?: unknown }).result)).toContain('Plan saved')
  const sub = await $.tool.call({ tool: PLAN, agentId: 'x', steps: [{ text: 'z', status: 'completed' }] } as never)
  expect(String((sub as { result?: unknown }).result)).toContain('Only the main chat')
  const ui = await $.ui.mount(pane())
  expect(await allText(ui)).toContain('0 of 2')
  await $.tool.call({ tool: PLAN, steps: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'pending' }] } as never)
  expect(await allText(ui)).toContain('1 of 2')
  expect(await allText(ui)).toContain('Ship')
  expect(await ui.find({ key: 'c:chatsidecar' })).toBeUndefined()
  expect((await ui.find({ key: 'connectors' }))?.text).toContain('None used yet')
})

test('P1#10: a long step wraps at 48 columns, each line at most 42 characters, title and count still shown', async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  const long = 'Rewrite the frame of the side pane so that every section keeps its own border and folds by itself'
  await $.tool.call({ tool: PLAN, title: 'Frame', steps: [{ text: long, status: 'pending' }] } as never)
  const ui = await $.ui.mount(pane('terminal', 48))
  const lines = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => long.includes(t) && t.length > 3)
  expect(lines.length).toBeGreaterThan(1)
  expect(lines.every(l => l.length <= 42)).toBe(true)
  expect(lines.join(' ')).toBe(long)
  expect(await allText(ui)).toContain('Frame')
  expect(await allText(ui)).toContain('0 of 1')
})

test('P1#11: no plan, a dim line and no count', async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  const texts = await ui.findAll({ type: 'Text' })
  const line = texts.find(t => t.text.startsWith('No to-do list yet.'))
  expect(line?.props.dimColor).toBe(true)
  expect(texts.some(t => / of \d+$/.test(t.text) && !t.text.includes('running'))).toBe(false)
})

const fourSteps = (statuses: string[]) => ({
  tool: PLAN,
  title: 'Release',
  steps: statuses.map((status, i) => ({ text: `Step ${i + 1}`, status })),
})

test('P1#12: the band says Tasks 2/4 and 50%, the desktop drawing in its alt text, the terminal a Now: line', async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  await $.tool.call({ tool: 'TodoWrite', todos: ['completed', 'completed', 'in_progress', 'pending'].map((status, i) => ({ content: `Step ${i + 1}`, status, activeForm: `Doing step ${i + 1}` })) } as never)
  const t = await $.ui.mount(band('terminal', 60))
  const text = await allText(t)
  expect(text).toContain('Tasks 2/4')
  expect(text).toContain('50%')
  expect(text).toContain('Now: Doing step 3')
  const d = await $.ui.mount(band('desktop', 60))
  const svg = await d.find({ type: 'Svg' })
  expect(svg?.props.alt).toBe('Plan: Tasks 2/4, 50%')
  expect(String(svg?.props.source)).toContain('Tasks 2/4')
})

test('P1#13 P1#14: all done shows Tasks 4/4 then nothing after 20 s; a new plan shows, ✕ hides, a change shows again', async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  await $.tool.call(fourSteps(['completed', 'completed', 'in_progress', 'pending']) as never)
  await $.tool.call(fourSteps(['completed', 'completed', 'completed', 'completed']) as never)
  const t = await $.ui.mount(band())
  expect(await allText(t)).toContain('Tasks 4/4')
  expect(await allText(t)).toContain('All steps done')
  await clock.advance(20_500)
  await t.redraw()
  expect(await allText(t)).not.toContain('Tasks')
  expect(await t.find({ key: 'engine' })).toBeDefined()

  await $.tool.call({ tool: PLAN, title: 'Next', steps: [{ text: 'a', status: 'pending' }, { text: 'b', status: 'pending' }] } as never)
  await t.redraw()
  expect(await allText(t)).toContain('Tasks 0/2')
  await t.press({ key: 'plan-dismiss' })
  expect(await allText(t)).not.toContain('Tasks')
  await $.tool.call({ tool: PLAN, steps: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'pending' }] } as never)
  await t.redraw()
  expect(await allText(t)).toContain('Tasks 1/2')
})

test('P1#15: hidden at start, the band draws no plan', async ($, on) => {
  const { clock, setSwitches } = seat(on)
  setSwitches({ 'chat-sidecar:hidden': true })
  await start($)
  await clock.settle()
  await $.tool.call(fourSteps(['completed', 'in_progress']) as never)
  const t = await $.ui.mount(band())
  expect(await allText(t)).not.toContain('Tasks')
  expect(await t.find({ key: 'engine' })).toBeDefined()
})

test('P1#16: barStyle dots draws one dot a step, the one in progress distinct, the pending one hollow', { options: { barStyle: 'dots' } }, async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  await $.tool.call(fourSteps(['completed', 'completed', 'in_progress', 'pending']) as never)
  const t = await $.ui.mount(band('terminal', 80))
  expect((await t.find({ key: 'band-bar' }))?.text).toBe('●─●─◉┄○')
})

test('P1#17 P3#21: the count shows alone, beside the plan, while hidden; pressing it opens the pane', async ($, on) => {
  const { world, clock, setSwitches } = seat(on)
  await start($)
  await clock.settle()
  let t = await $.ui.mount(band())
  expect(await t.find({ key: 'band-tasks' })).toBeUndefined()
  await $.tool.call(TASK)
  await $.tool.call(TASK2)
  await t.redraw()
  expect((await t.find({ key: 'band-tasks' }))?.text).toBe('● 2 for you')
  expect(await allText(t)).not.toContain('Tasks ')
  await $.tool.call(fourSteps(['in_progress', 'pending']) as never)
  await t.redraw()
  expect(await allText(t)).toContain('Tasks 0/2')
  expect(await t.find({ key: 'band-tasks' })).toBeDefined()
  setSwitches({ 'chat-sidecar:hidden': true })
  await clock.advance(3500)
  t = await $.ui.mount(band())
  expect((await t.find({ key: 'band-tasks' }))?.text).toBe('● 2 for you')
  expect(await allText(t)).not.toContain('Tasks 0/2')
  const opens = world.opens.length
  await t.press({ key: 'band-tasks' })
  expect(world.opens.length).toBe(opens + 1)
  expect(world.opens.at(-1)).toMatchObject({ id: 'chat-sidecar', focus: true })
  expect(world.files[SWITCHES]).toBe('{}\n')
})

test('P1#18 P3#19: Tasks for me off appears once a task waits, with its buttons; the plan tool still saves', { options: { showTasks: false, showTodo: false } }, async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ key: 'tasks' })).toBeUndefined()
  await $.tool.call(TASK)
  expect((await ui.find({ key: 'tasks' }))?.text).toContain('Add the API key to .env')
  expect(await ui.find({ key: 't-1-done' })).toBeDefined()
  const saved = await $.tool.call({ tool: PLAN, steps: [{ text: 'a', status: 'pending' }] } as never)
  expect(String((saved as { result?: unknown }).result)).toBe('Plan saved. Send the whole list again on every change.')
})

test('P1#19: Background, Subagents and Context files off: no scans or polls, those sections absent, an always-loaded skill shows', { options: { showBackground: false, showSubagents: false, showFiles: false } }, async ($, on) => {
  const { world, clock } = seat(on)
  world.memoryFiles = [{ path: `${HOME}/.claude/skills/house-style/SKILL.md`, type: 'user', tokens: 1 }]
  world.agents = [{ id: 'a1', description: 'Look around', type: 'Explore', status: 'running' }]
  await start($)
  await clock.settle()
  await $.agent.spawn({ prompt: 'x', description: 'Look around', subagentType: 'Explore' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.md', agentId: 'agent-11' } as never)
  const lists = world.agentLists
  await clock.advance(30_000)
  expect(world.runs.filter(r => ['netstat', 'ss', 'powershell', 'ps'].includes(r[0]!))).toEqual([])
  expect(world.agentLists).toBe(lists)
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ key: 'sec-todo' })).toBeDefined()
  for (const id of ['background', 'subagents', 'files']) expect(await ui.find({ key: `sec-${id}` })).toBeUndefined()
  expect((await ui.find({ key: 'skills' }))?.text).toContain('house-style')
  expect((await ui.find({ key: 'skills' }))?.text).toContain('always loaded')
})

test('P1#20: sectionOrder "skills, todo" draws skills, todo, tasks, then the rest', { options: { sectionOrder: 'skills, todo' } }, async ($, on) => {
  const { world, clock } = seat(on)
  world.proc = argv => (argv[0] === 'git' && argv[1] === 'rev-parse' ? 'main\n/repo/.git\n/repo/.git\n' : null)
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  const order = (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k?.startsWith('sec-'))
  expect(order).toEqual(['sec-skills', 'sec-todo', 'sec-tasks', 'sec-subagents', 'sec-background', 'sec-connectors', 'sec-files', 'sec-git'])
})

test('P1#21: every section off: the all-off line and the Settings button', { options: only() }, async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  expect(await allText(ui)).toContain('All sections are off')
  expect(await ui.find({ key: 'pane-settings' })).toBeDefined()
})

/** The config rows the settings screen writes through, at the defaults; `over` changes values or locks. */
function rows(over: Record<string, { value?: unknown; isLocked?: boolean }> = {}): Row[] {
  const defaults: Record<string, unknown> = {
    showTodo: true, showTasks: true, showSubagents: true, showBackground: true, showConnectors: true, showFiles: true, showSkills: true, showGit: true,
    sectionOrder: 'todo, tasks, subagents, background, connectors, files, skills, git',
    bandColor: 'purple', barStyle: 'gradient', ports: '8090=backend, 8091=backend, 5005=debug, 4200=frontend, 4201=frontend',
    pollSeconds: 10,
  }
  return Object.entries(defaults).map(([field, value]) => ({
    key: `chat-sidecar.${field}`, label: field, kind: 'string', value: over[field]?.value ?? value, provider: { kind: 'plugin' }, isLocked: over[field]?.isLocked ?? false,
  }))
}

test('P1#22: the settings screen: Sections, no up button on the first row, a toggle and a move write their fields', async ($, on) => {
  const { world, clock } = seat(on)
  world.rows = rows()
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'pane-settings' })
  expect(await allText(ui)).toContain('Sections')
  expect(await ui.find({ key: 'set-up-todo' })).toBeUndefined()
  expect(await ui.find({ key: 'set-down-git' })).toBeUndefined()
  await ui.press({ key: 'set-show-background' })
  expect(world.sets).toEqual([{ key: 'chat-sidecar.showBackground', value: false }])
  await ui.press({ key: 'set-down-todo' })
  expect(world.sets.at(-1)).toEqual({ key: 'chat-sidecar.sectionOrder', value: 'tasks, todo, subagents, background, connectors, files, skills, git' })
})

test('P1#23: colours and bar styles: the chosen one is no button, the others write', async ($, on) => {
  const { world, clock } = seat(on)
  world.rows = rows()
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'pane-settings' })
  expect(await ui.find({ key: 'set-color-purple' })).toBeUndefined()
  await ui.press({ key: 'set-color-navy' })
  expect(world.sets.at(-1)).toEqual({ key: 'chat-sidecar.bandColor', value: 'navy' })
  expect(await ui.find({ key: 'set-bar-gradient' })).toBeUndefined()
  const text = await allText(ui)
  for (const name of ['Gradient', 'Segments', 'Line', 'Dots', 'Pixel']) expect(text).toContain(name)
  expect(text).toContain('▰▰▰▰▰▰')
  expect(text).toContain('●─●─●─◉┄○')
  await ui.press({ key: 'set-bar-dots' })
  expect(world.sets.at(-1)).toEqual({ key: 'chat-sidecar.barStyle', value: 'dots' })
})

test('P1#24: Reset writes only the field that differs; Done closes the screen', { options: { showSkills: false } }, async ($, on) => {
  const { world, clock } = seat(on)
  world.rows = rows({ showSkills: { value: false } })
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'pane-settings' })
  await ui.press({ key: 'set-reset' })
  expect(world.sets).toEqual([{ key: 'chat-sidecar.showSkills', value: true }])
  expect(await allText(ui)).toContain('Sections')
  await ui.press({ key: 'set-done' })
  expect(await allText(ui)).not.toContain('Background ports')
  expect(await ui.find({ key: 'pane-settings' })).toBeDefined()
})

test('P1#25: /chat-sidecar settings opens on the screen; a locked field has no toggle; unset ports show the defaults', async ($, on) => {
  const { world, clock } = seat(on)
  world.rows = rows({ showTodo: { isLocked: true }, ports: { value: '' } })
  await start($)
  await clock.settle()
  expect((await command($, 'chat-sidecar', ' Settings ')).text).toBe('Opened the chat sidecar settings.')
  expect(world.opens.at(-1)?.id).toBe('chat-sidecar')
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ key: 'set-show-todo' })).toBeUndefined()
  expect(await allText(ui)).toContain('To-do (set by your organisation)')
  expect((await ui.find({ key: 'set-ports' }))?.props.value).toBe('8090=backend, 8091=backend, 5005=debug, 4200=frontend, 4201=frontend')
})

test('P1#26: a bad ports entry is shown and nothing written; a good one is written', async ($, on) => {
  const { world, clock } = seat(on)
  world.rows = rows()
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'pane-settings' })
  await ui.input({ key: 'set-ports', text: '9000=api, oops', kind: 'change' })
  await ui.input({ key: 'set-ports', text: '9000=api, oops' })
  expect(await allText(ui)).toContain('Not understood: oops (expected port=label)')
  expect(world.sets).toEqual([])
  expect((await ui.find({ key: 'set-ports' }))?.props.value).toBe('9000=api, oops')
  await ui.input({ key: 'set-ports', text: '9000=api' })
  expect(world.sets).toEqual([{ key: 'chat-sidecar.ports', value: '9000=api' }])
  expect(await allText(ui)).not.toContain('Not understood')
})

// =====================================================================================================================
// Part 2: Subagents, Connectors, Context files, Skills
// =====================================================================================================================

const GMAIL = 'mcp__1a2b3c4d-0000-1111__search_threads'
const FIREFLIES = 'mcp__9f8e7d6c-1111-2222__fireflies_get_transcripts'

async function useThings($: Engine) {
  await $.tool.call({ tool: GMAIL, query: 'invoices from May' } as never)
  await $.tool.call({ tool: GMAIL, query: 'receipts' } as never)
  await $.tool.call({ tool: FIREFLIES, transcriptId: 'tr-42' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/docs/meeting-notes.md' } as never)
  await $.tool.call({ tool: 'Skill', skill: 'video-prep' } as never)
}

test('P2#1: connectors, files and skills used show; memory files are auto, a memory SKILL.md is always loaded', async ($, on) => {
  const { world, clock } = seat(on)
  world.memoryFiles = [
    { path: `${HOME}/.claude/CLAUDE.md`, type: 'user', tokens: 1 },
    { path: `${HOME}/.claude/skills/house-style/SKILL.md`, type: 'user', tokens: 1 },
  ]
  await start($)
  await clock.settle()
  await useThings($)
  const ui = await $.ui.mount(pane())
  const text = await allText(ui)
  for (const s of ['Gmail', 'Fireflies', 'meeting-notes.md', 'video-prep', 'CLAUDE.md', 'house-style', 'always loaded']) expect(text).toContain(s)
  expect(text).not.toContain('SKILL.md')
  expect(text).not.toContain('None used yet')
  expect(text).not.toContain('Slack')
  expect((await ui.find({ key: 'files' }))?.text).toContain('auto')
})

test('P2#2: desktop tiles, one logo each with its alt; terminal call counts', async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  await useThings($)
  const d = await $.ui.mount(pane('desktop'))
  const svgs = await d.findAll({ type: 'Svg' })
  expect(svgs).toHaveLength(2)
  const gmail = svgs.find(s => String(s.props.alt).startsWith('Gmail'))
  expect(gmail?.props.alt).toBe('Gmail, 2 calls')
  expect(String(gmail?.props.source)).toContain(LOGOS.gmail!.path)
  expect(svgs.find(s => String(s.props.alt).startsWith('Fireflies'))?.props.alt).toBe('Fireflies, 1 call')
  const t = await $.ui.mount(pane('terminal'))
  const text = await allText(t)
  expect(text).toContain('2 calls')
  expect(text).toContain('1 call')
})

test('P2#3: gws in command position counts as Gmail and Google Calendar via CLI; gwsx and ~/gws do not', async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: "cd ~; gws gmail users messages list --params '{\"q\":\"from:bob\"}'" } as never)
  await $.tool.call({ tool: 'Bash', command: 'cd ~ && gws calendar events list' } as never)
  await $.tool.call({ tool: 'Bash', command: 'echo gwsx; ls ~/gws' } as never)
  const ui = await $.ui.mount(pane())
  expect((await ui.find({ key: 'c:gmail' }))?.text).toContain('via CLI')
  expect((await ui.find({ key: 'c:googlecalendar' }))?.text).toContain('via CLI')
  expect(await ui.find({ key: 'c:google' })).toBeUndefined()
})

test('P2#4: a SKILL.md read is a skill, not a context file', async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  await $.tool.call({ tool: 'Read', file_path: '/repo/.claude/skills/foo/SKILL.md' } as never)
  const ui = await $.ui.mount(pane())
  expect((await ui.find({ key: 'skills' }))?.text).toContain('/foo')
  expect((await ui.find({ key: 'files' }))?.text).not.toContain('SKILL.md')
})

test('P2#5: one call list open at a time', async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  await useThings($)
  const ui = await $.ui.mount(pane())
  expect(await allText(ui)).not.toContain('search threads')
  await ui.press({ key: 'c:gmail' })
  let text = await allText(ui)
  expect(text).toContain('search threads')
  expect(text).toContain('invoices from May')
  expect(text).not.toContain('get transcripts')
  await ui.press({ key: 'c:fireflies' })
  text = await allText(ui)
  expect(text).toContain('get transcripts')
  expect(text).not.toContain('search threads')
  await ui.press({ key: 'c:fireflies' })
  expect(await allText(ui)).not.toContain('get transcripts')
})

test('P2#7: id servers are named by their tools, never by their id', async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  const calls = [
    'mcp__aaaaaaaa-0001__list_landing_pages',
    'mcp__aaaaaaaa-0001__list_posts',
    'mcp__bbbbbbbb-0002__list_spaces',
    'mcp__cccccccc-0003__call-actor',
    'mcp__dddddddd-0004__notion-search',
    'mcp__plugin_demo_fireflies__get_transcript',
    'mcp__claude_ai_Slack__slack_send_message',
    'mcp__eeeeeeee-0005__do_something_new',
  ]
  for (const tool of calls) await $.tool.call({ tool, q: 'x' } as never)
  const ui = await $.ui.mount(pane())
  for (const key of ['kit', 'circle', 'apify', 'notion', 'fireflies', 'slack', 'connector']) expect(await ui.find({ key: `c:${key}` })).toBeDefined()
  expect(await allText(ui)).not.toMatch(/[0-9a-f]{8}-\d{4}/)
  await ui.press({ key: 'c:kit' })
  const text = await allText(ui)
  expect(text).toContain('list landing pages')
  expect(text).toContain('list posts')
})

test('P2#8 P2#9: 14 files and a memory file: a window of 10 that moves by 5', async ($, on) => {
  const { world, clock } = seat(on)
  world.memoryFiles = [{ path: `${HOME}/CLAUDE.md`, type: 'user', tokens: 1 }]
  await start($)
  await clock.settle()
  for (let i = 1; i <= 14; i++) await $.tool.call({ tool: 'Read', file_path: `/repo/f${i}.md` } as never)
  const ui = await $.ui.mount(pane())
  const files = async () => (await ui.find({ key: 'files' }))?.text ?? ''
  expect(await files()).toContain('Files read')
  expect(await files()).toContain('1 to 10 of 15')
  expect(await files()).toContain('f14.md')
  expect(await ui.find({ key: 'files-up' })).toBeUndefined()
  await ui.press({ key: 'files-down' })
  expect(await files()).toContain('6 to 15 of 15')
  expect(await files()).not.toContain('f14.md')
  expect(await files()).toContain('CLAUDE.md')
  expect(await ui.find({ key: 'files-down' })).toBeUndefined()
  await ui.press({ key: 'files-up' })
  expect(await files()).toContain('1 to 10 of 15')
})

test('P2#9: one file read shows the Files read line', async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  await $.tool.call({ tool: 'Read', file_path: '/repo/one.md' } as never)
  const ui = await $.ui.mount(pane())
  expect((await ui.find({ key: 'files' }))?.text).toContain('Files read')
  expect((await ui.find({ key: 'files' }))?.text).toContain('one.md')
})

/** Two subagents spawned, one call each (P2#10). */
async function twoAgents($: Engine, world: ReturnType<typeof seat>['world']) {
  world.spawnId = e => (e.description.startsWith('Read') ? 'a1' : 'a2')
  await $.agent.spawn({ prompt: 'x', description: 'Read the research notes', subagentType: 'Explore', model: 'haiku' } as never)
  await $.agent.spawn({ prompt: 'y', description: 'Find invoice threads', subagentType: 'general-purpose', model: 'opus' } as never)
  await $.tool.call({ tool: 'Read', file_path: `${HOME}/notes/research.md`, agentId: 'a1' } as never)
  await $.tool.call({ tool: GMAIL, query: 'invoice', agentId: 'a2' } as never)
}

test('P2#10 P2#11 P2#12 P2#13: subagent cards run, finish, are polled, and their groups fold', async ($, on) => {
  const { world, clock } = seat(on)
  world.agents = [
    { id: 'a1', description: 'Read the research notes', type: 'Explore', status: 'running' },
    { id: 'a2', description: 'Find invoice threads', type: 'general-purpose', status: 'running' },
  ]
  await start($)
  await clock.settle()
  await twoAgents($, world)
  const ui = await $.ui.mount(pane())
  let text = await allText(ui)
  for (const s of ['Subagents', '2 running of 2', 'Read the research notes', 'Find invoice threads', 'Step 1 · Reading research.md', 'Gmail: search threads', 'Running · 2', 'Explore · Haiku'])
    expect(text).toContain(s)
  expect((await ui.find({ key: 'head-running' }))?.props.backgroundColor).toBe('blue')

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1', agentId: 'a1', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 30000, cache_creation_input_tokens: 2000, model: 'haiku' } } as never)
  text = await allText(ui)
  expect(text).toContain('Finished · 1')
  expect(text).toContain('34k tokens')
  expect(text).toContain('1 running of 2')
  expect((await ui.find({ key: 'head-finished' }))?.props.backgroundColor).toBeUndefined()

  world.agents = [world.agents[0]!, { ...world.agents[1]!, status: 'completed' }]
  await clock.advance(2100)
  text = await allText(ui)
  expect(text).toContain('Finished · 2')
  expect(text).not.toContain('Running ·')

  await ui.press({ key: 'group-finished' })
  expect(await ui.find({ key: 'card-a1' })).toBeUndefined()
  await ui.press({ key: 'group-finished' })
  expect(await ui.find({ key: 'card-a1' })).toBeDefined()
})

test('P2#14: six calls: the live line, the recent steps, and the expanded list', async ($, on) => {
  const { world, clock } = seat(on)
  world.agents = [{ id: 'a1', description: 'Research', type: 'Explore', status: 'running' }]
  await start($)
  await clock.settle()
  world.spawnId = () => 'a1'
  await $.agent.spawn({ prompt: 'x', description: 'Research', subagentType: 'Explore' } as never)
  const a = { agentId: 'a1' }
  await $.tool.call({ tool: 'Read', file_path: `${HOME}/notes/first.md`, ...a } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls /tmp', description: 'List the temp folder', ...a } as never)
  await $.tool.call({ tool: 'mcp__12345678-aaaa__list_recent_files', ...a } as never)
  await $.tool.call({ tool: 'Skill', skill: 'video-prep', ...a } as never)
  await $.tool.call({ tool: 'WebFetch', url: 'https://docs.example.com/page', ...a } as never)
  await $.tool.call({ tool: 'Write', file_path: `${HOME}/notes/research.md`, ...a } as never)
  const ui = await $.ui.mount(pane())
  let card = (await ui.find({ key: 'card-a1' }))?.text ?? ''
  expect(card).toContain('Step 6 · Writing research.md')
  expect(card).toContain('Opening docs.example.com')
  expect(card).not.toContain('Reading first.md')
  expect((await ui.find({ key: 'steps-a1' }))?.text).toBe('▸ All 6 steps')
  await ui.press({ key: 'steps-a1' })
  card = (await ui.find({ key: 'card-a1' }))?.text ?? ''
  expect((await ui.find({ key: 'steps-a1' }))?.text).toBe('▾ Hide steps')
  for (const s of ['File read', 'File write', 'first.md', '~/notes', 'List the temp folder', 'Google Drive · list recent files', 'video-prep', 'docs.example.com']) expect(card).toContain(s)
  await ui.press({ key: 'steps-a1' })
  expect((await ui.find({ key: 'steps-a1' }))?.text).toBe('▸ All 6 steps')
})

test('P2#19: a second start in the same session counts nothing again and keeps the open list', async ($, on) => {
  const { world, clock } = seat(on)
  world.messages = [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'h1', tool: GMAIL, input: { query: 'old' } }] }]
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  expect(await allText(ui)).toContain('1 call')
  await ui.press({ key: 'c:gmail' })
  await start($)
  await clock.settle()
  await ui.redraw()
  expect(await allText(ui)).toContain('1 call')
  expect(await allText(ui)).toContain('Gmail calls, newest first')
})

test('seeding: history replays the plan and counts tool uses with their transcript times', async ($, on) => {
  const { world, clock } = seat(on)
  world.messages = [
    { role: 'user', text: '/video-prep now', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'h1', tool: PLAN, input: { title: 'Old', steps: [{ text: 'x', status: 'completed' }, { text: 'y', status: 'pending' }] } }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'h2', tool: 'Agent', input: { description: 'd' }, agentId: 'sub1' }] },
  ]
  world.subMessages = { sub1: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'h3', tool: 'Read', input: { file_path: '/repo/sub.md' } }] }] }
  world.skills = [{ name: 'video-prep', source: 'user', tokens: 1 }]
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  const text = await allText(ui)
  expect(text).toContain('1 of 2')
  expect(text).toContain('sub.md')
  expect(text).toContain('video-prep')
  expect(text).toContain('None yet. Cards show up when Claude starts a subagent.')
})

// =====================================================================================================================
// Part 3: hosting Background, Git and Tasks for me
// =====================================================================================================================

const NETSTAT = (lines: string[]) => ['Active Connections', ...lines].join('\r\n')

test('P3#1: on Windows the port scan runs at start and every 10 s, processes at 0, 30 and 60 s; a second start adds no timer', { options: only('background') }, async ($, on) => {
  const { world, clock } = seat(on, { windows: true })
  world.proc = argv => (argv[0] === 'netstat' ? NETSTAT([]) : argv[0] === 'powershell' ? '' : null)
  await start($)
  await clock.settle()
  await start($)
  await clock.settle()
  await clock.advance(60_000)
  expect(world.runs.filter(r => r[0] === 'netstat')).toHaveLength(7)
  expect(world.runs.filter(r => r[0] === 'powershell')).toHaveLength(3)
})

/** A Linux machine: `ss` lists `ports` (port -> [image, pid]), `ps` lists `procs`. */
function linux(world: ReturnType<typeof seat>['world'], ports: Record<number, [string, number]>, procs: string[] = []) {
  world.proc = argv => {
    if (argv[0] === 'ss') return Object.entries(ports).map(([port, [image, pid]]) => `LISTEN 0 100 *:${port} *:* users:(("${image}",pid=${pid},fd=4))`).join('\n')
    if (argv[0] === 'ps') return procs.join('\n')
    return null
  }
}

test('P3#2 P3#4: a server on 8090: header, chips, the frontend label, and the details with a link', { options: only('background') }, async ($, on) => {
  const { world, clock } = seat(on)
  linux(world, { 8090: ['java', 4242] })
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  expect((await ui.find({ key: 'background' }))?.text).toContain('1 of 5 up')
  expect((await ui.find({ key: 'bg-port-8090' }))?.text).toMatch(/^:8090 ● \d+m$/)
  expect((await ui.find({ key: 'bg-port-8091' }))?.text).toBe(':8091 ○')
  expect((await ui.find({ key: 'background' }))?.text).toContain('frontend')
  await ui.press({ key: 'bg-port-8090' })
  expect(await allText(ui)).toContain(':8090 · java · pid 4242')
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('http://localhost:8090')
  await ui.press({ key: 'bg-port-8090' })
  expect(await allText(ui)).not.toContain('pid 4242')
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
})

test('P3#3: a port held by another process is a warning, explained in its details, with no link', { options: only('background') }, async ($, on) => {
  const { world, clock } = seat(on)
  linux(world, { 8090: ['java', 1], 4200: ['svchost.exe', 77] })
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  expect((await ui.find({ key: 'background' }))?.text).toContain('1 of 5 up · 1 ⚠')
  expect((await ui.find({ key: 'bg-port-4200' }))?.text).toBe(':4200 ⚠ svchost')
  await ui.press({ key: 'bg-port-4200' })
  expect(await allText(ui)).toContain('svchost.exe holds the port, so the frontend server cannot start on it.')
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
})

test('P3#5: a debug port uses the permission colour and has no link', { options: only('background') }, async ($, on) => {
  const { world, clock } = seat(on)
  linux(world, { 5005: ['java', 9] })
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.find(t => t.text === 'debug')?.props.color).toBe('permission')
  expect(texts.find(t => t.text === '●')?.props.color).toBe('permission')
  await ui.press({ key: 'bg-port-5005' })
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
})

test('P3#6: idle groups fold away and back', { options: only('background') }, async ($, on) => {
  const { world, clock } = seat(on)
  linux(world, {})
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  expect((await ui.find({ key: 'bg-idle' }))?.text).toBe('▾ hide 3 idle')
  await ui.press({ key: 'bg-idle' })
  expect((await ui.find({ key: 'bg-idle' }))?.text).toBe('▸ 3 idle')
  expect(await ui.find({ key: 'bg-port-8090' })).toBeUndefined()
  await ui.press({ key: 'bg-idle' })
  expect((await ui.find({ key: 'bg-idle' }))?.text).toBe('▾ hide 3 idle')
  expect(await ui.find({ key: 'bg-port-8090' })).toBeDefined()
})

const FORK = (pid: number) => `${pid} java /usr/bin/java -jar /proj/target/surefire/surefirebooter${pid}.jar /proj/target/surefire`

test('P3#7: test runs: a Tests heading, the forks counted, the age turning yellow then red; a server stays dim', { options: only('background') }, async ($, on) => {
  const { world, clock } = seat(on)
  linux(world, { 8090: ['java', 1] }, [FORK(11), FORK(12), FORK(13)])
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  expect(await allText(ui)).toContain('Tests')
  expect(await allText(ui)).toContain('backend tests (surefire) ×3')
  const ageOf = async (m: string) => (await ui.findAll({ type: 'Text' })).filter(t => t.text === m || t.text === ` ${m}`)
  await clock.advance(16 * 60_000)
  let ages = await ageOf('16m')
  expect(ages.map(a => a.props.color ?? (a.props.dimColor ? 'dim' : ''))).toEqual(['dim', 'warning'])
  await clock.advance(15 * 60_000)
  ages = await ageOf('31m')
  expect(ages.map(a => [a.props.color ?? (a.props.dimColor ? 'dim' : ''), a.props.bold === true])).toEqual([
    ['dim', false],
    ['error', true],
  ])
})

const MVN = '20 java /usr/bin/java -classpath /m/boot/plexus-classworlds.jar -Dmaven.multiModuleProjectDirectory=/proj org.codehaus.plexus.classworlds.launcher.Launcher test'

test('P3#8: a remembered total draws a bar in the bar style and done/total; none, only the count', { options: { ...only('background'), barStyle: 'segments' } }, async ($, on) => {
  const { world, clock } = seat(on, { store: { 'total:/proj': 40 } })
  linux(world, {}, [MVN, FORK(11)])
  world.dirs['/proj/target/surefire-reports'] = ['A', 'B', 'C'].map(n => ({ name: `com.x.${n}Test.txt`, kind: 'file' as const, size: 1, mtimeMs: NOW + 1000 }))
  for (const n of ['A', 'B', 'C']) world.files[`/proj/target/surefire-reports/com.x.${n}Test.txt`] = 'Tests run: 10, Failures: 0'
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  expect((await ui.find({ key: 'bar-proc:backend tests (surefire)' }))?.text).toBe('▰▰▰▰▰▰▰▰▱▱')
  expect(await allText(ui)).toContain('30/40')
})

test('P3#8: with no remembered total only the count shows', { options: only('background') }, async ($, on) => {
  const { world, clock } = seat(on)
  linux(world, {}, [MVN, FORK(11)])
  world.dirs['/proj/target/surefire-reports'] = [{ name: 'com.x.ATest.txt', kind: 'file', size: 1, mtimeMs: NOW + 1000 }]
  world.files['/proj/target/surefire-reports/com.x.ATest.txt'] = 'Tests run: 30'
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ key: 'bar-proc:backend tests (surefire)' })).toBeUndefined()
  expect((await textsOf(ui)).includes('30')).toBe(true)
})

test('P3#9: off before start: no scan and no git in 60 s', async ($, on) => {
  const { world, clock, setSwitches } = seat(on)
  setSwitches({ 'chat-sidecar': false })
  linux(world, { 8090: ['java', 1] })
  await start($)
  await clock.advance(60_000)
  expect(world.runs).toEqual([])
})

test('P3#10: Background off: no port scan, no section', { options: { showBackground: false } }, async ($, on) => {
  const { world, clock } = seat(on)
  linux(world, { 8090: ['java', 1] })
  await start($)
  await clock.advance(30_000)
  expect(world.runs.filter(r => r[0] === 'ss' || r[0] === 'ps')).toEqual([])
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ key: 'background' })).toBeUndefined()
})

/** A git that answers rev-parse for a worktree `feat1` made from `main`. */
function worktree(world: ReturnType<typeof seat>['world']) {
  world.proc = argv => {
    if (argv[0] !== 'git') return null
    if (argv[1] === 'rev-parse') return 'feat1\n/home/me/repo/.git/worktrees/feat1\n/home/me/repo/.git\n'
    if (argv[1] === 'reflog' && argv.includes('refs/heads/feat1')) return 'commit: wip\nbranch: Created from main\n'
    return null
  }
}

test('P3#11: a worktree: branch, base, worktree, main repo; reads every 60 s and after a main-chat git call only', { options: only('git') }, async ($, on) => {
  const { world, clock } = seat(on)
  worktree(world)
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  const git = (await ui.find({ key: 'git' }))?.text ?? ''
  expect(git).toContain('feat1')
  expect((await ui.find({ key: 'git-base' }))?.text).toContain('main')
  expect((await ui.find({ key: 'git-worktree' }))?.text).toContain('yes')
  expect((await ui.find({ key: 'git-main' }))?.text).toContain('~/repo')
  const n = world.runs.length
  await clock.advance(60_000)
  expect(world.runs.length).toBe(n + 1)
  await $.tool.call({ tool: 'Bash', command: 'git switch main' } as never)
  await clock.settle()
  expect(world.runs.length).toBe(n + 2)
  await $.tool.call({ tool: 'Bash', command: 'git status', agentId: 'sub' } as never)
  await clock.settle()
  expect(world.runs.length).toBe(n + 2)
})

test('P3#12: outside a repo with only Git on, no Git section and the all-off line', { options: only('git') }, async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ key: 'git' })).toBeUndefined()
  expect(await allText(ui)).toContain('All sections are off')
})

test('P3#13: a branch made from a commit takes the nearest main remote branch as its base', { options: only('git') }, async ($, on) => {
  const { world, clock } = seat(on)
  const sha = '69ec47d0123456789abcdef0123456789abcdef0'
  world.proc = argv => {
    if (argv[0] !== 'git') return null
    if (argv[1] === 'rev-parse') return 'feat2\n/r/.git\n/r/.git\n'
    if (argv[1] === 'reflog' && argv.includes('refs/heads/feat2')) return `branch: Created from ${sha}\n`
    if (argv[1] === 'for-each-ref') return 'origin/dev-next\norigin/develop\n'
    if (argv[1] === 'rev-list') return argv.at(-1)!.endsWith('dev-next') ? '0\n' : '40\n'
    return null
  }
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  expect((await ui.find({ key: 'git-base' }))?.text).toContain('origin/dev-next · 69ec47d')
})

test('P3#14: Git off never runs git, even after a git call', { options: { showGit: false } }, async ($, on) => {
  const { world, clock } = seat(on)
  worktree(world)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'git switch main' } as never)
  await clock.advance(61_000)
  expect(world.runs.filter(r => r[0] === 'git')).toEqual([])
})

test('P3#17: hidden, an assigned task opens nothing; /my-tasks un-hides, closes settings, unfolds and opens with focus', async ($, on) => {
  const { world, clock, setSwitches } = seat(on)
  await start($)
  await clock.settle()
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'sec-tasks' })
  await ui.press({ key: 'pane-settings' })
  setSwitches({ 'chat-sidecar:hidden': true, keep: true })
  await clock.advance(3500)
  const opens = world.opens.length
  await $.tool.call(TASK)
  expect(world.opens.length).toBe(opens)
  await command($, 'my-tasks')
  expect(JSON.parse(world.files[SWITCHES]!)).toEqual({ keep: true })
  expect(world.opens.at(-1)).toMatchObject({ id: 'chat-sidecar', focus: true })
  await ui.redraw()
  expect(await allText(ui)).not.toContain('Background ports')
  expect(await ui.find({ key: 't-1-done' })).toBeDefined()
})

test('P3#18: off, bringing up Tasks for me resolves false and opens nothing', async ($, on) => {
  const { world, clock, setSwitches } = seat(on)
  setSwitches({ 'chat-sidecar': false })
  await start($)
  await clock.settle()
  // Both paths into sidecarShowTasks: a task (unasked; refused while off) and /my-tasks (asked).
  expect((await $.tool.call(TASK)) as { deny?: string }).toMatchObject({ deny: expect.stringContaining('turned the chat sidecar off') })
  expect((await command($, 'my-tasks')).text).toContain('The chat sidecar is off')
  expect(world.opens).toEqual([])
  expect(world.files[SWITCHES]).toBe('{"chat-sidecar":false}')
})

test('P3#20: open tasks paint the frame, title and count in warning; withdrawn, the frame has no colour', async ($, on) => {
  const { clock } = seat(on)
  await start($)
  await clock.settle()
  await $.tool.call(TASK)
  const ui = await $.ui.mount(pane())
  expect((await ui.find({ key: 'tasks' }))?.props.borderColor).toBe('warning')
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.find(t => t.text === 'Tasks for me')?.props.color).toBe('warning')
  expect(texts.find(t => t.text === '1')?.props.color).toBe('warning')
  await $.tool.call({ tool: WITHDRAW, id: 1 } as never)
  expect((await ui.find({ key: 'tasks' }))?.text).toContain('Nothing waiting for you.')
  expect((await ui.find({ key: 'tasks' }))?.props.borderColor).toBeUndefined()
})

test('P3#22 P3#23: a draft survives folding, the settings screen, and Hide then /my-tasks; no draft, no pane listing', async ($, on) => {
  const { world, clock } = seat(on)
  await start($)
  await clock.settle()
  await $.tool.call({ tool: ASSIGN, title: 'Paste the failing test names', why: 'I cannot run them.', kind: 'answer' } as never)
  await command($, 'my-tasks')
  expect(world.panesAsked).toBe(0)
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 't-1-answer' })
  await ui.input({ key: 'answer-1', text: 'LoginTests', kind: 'change' })
  await clock.settle()
  await ui.press({ key: 'sec-tasks' })
  await ui.press({ key: 'sec-tasks' })
  expect((await ui.find({ key: 'answer-1' }))?.props.value).toBe('LoginTests')
  await ui.press({ key: 'pane-settings' })
  await ui.press({ key: 'set-done' })
  expect((await ui.find({ key: 'answer-1' }))?.props.value).toBe('LoginTests')
  await ui.press({ key: 'pane-hide' })
  await ui.unmount()
  await command($, 'my-tasks')
  const again = await $.ui.mount(pane())
  expect((await again.find({ key: 'answer-1' }))?.props.value).toBe('LoginTests')
})

test('P3#24: the band hands isWorking to the task part, true then false, and keeps the drawing beneath', async ($, on) => {
  const { world, clock } = seat(on)
  await start($)
  await clock.settle()
  const t = await $.ui.mount(band('terminal', 60, true))
  await clock.advance(10)
  expect(world.working.at(-1)).toBe(true)
  await t.redraw({ ...band('terminal', 60, false).props })
  await clock.advance(10)
  expect(world.working.at(-1)).toBe(false)
  expect(await t.find({ key: 'engine' })).toBeDefined()
})

test('P3#25: a second start keeps Background, Git and task state, and starts no second timer', { options: only('background', 'git', 'tasks') }, async ($, on) => {
  const { world, clock } = seat(on)
  linux(world, { 8090: ['java', 1] })
  const base = world.proc
  world.proc = argv => (argv[0] === 'git' && argv[1] === 'rev-parse' ? 'main\n/r/.git\n/r/.git\n' : base(argv))
  await start($)
  await clock.settle()
  await $.tool.call(TASK)
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'bg-port-8090' })
  await ui.press({ key: 'bg-idle' })
  await start($)
  await clock.settle()
  await ui.redraw()
  expect(await allText(ui)).toContain('pid 1')
  expect((await ui.find({ key: 'bg-idle' }))?.text).toContain('idle')
  expect((await ui.find({ key: 'git' }))?.text).toContain('main')
  expect(await ui.find({ key: 't-1-done' })).toBeDefined()
  const scans = world.runs.filter(r => r[0] === 'ss').length
  await clock.advance(10_000)
  expect(world.runs.filter(r => r[0] === 'ss').length).toBe(scans + 1)
})
