import { expect, test } from 'claude-code/testing'

import { BAND_COLOR_IDS, bandColorOf, bandCounts, bandSvg, mix } from './band'
import { BAR_STYLE_IDS, agentParts } from './barstyle'
import { hintOf, mcpCallText, mcpSummary, parseCli, rowKey, serverName, stepWords } from './connectors'
import {
  EMPTY_INVENTORY,
  EMPTY_PLAN,
  addConnectorCall,
  addFile,
  addMemoryFiles,
  addSkill,
  applyPlanTool,
  applyTaskCreate,
  applyTaskUpdate,
  applyTodoWrite,
  backgroundLine,
  badPorts,
  bandNote,
  barParts,
  clampTop,
  elapsed,
  filesShown,
  homeShort,
  isSpill,
  modelShort,
  nextBand,
  pickColor,
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
  wrap,
} from './helpers'
import type { Card, Listener } from '../types'

const names = new Map<string, string>()
const nameOf = (server: string, tool: string) => serverName(server, tool, names)

// ---- Part 2, acceptance 15 and 16: the bar contracts ----

test('barParts: done is full; working always totals the width (part 2 #15)', () => {
  expect(barParts('done', 6, 3, 1)).toEqual(['', '██████', ''])
  expect(barParts('failed', 6, 0, 0)).toEqual(['', '██████', ''])
  for (let tick = 0; tick < 40; tick++)
    for (const seat of [0, 1, 2, 7]) {
      const [a, b, c] = barParts('working', 6, tick, seat)
      expect(a.length + b.length + c.length).toBe(6)
      expect(`${a}${b}${c}`).toMatch(/^░*█*░*$/)
    }
  expect(barParts('working', 12, 3, 0).join('')).toBe('░░░███░░░░░░')
})

test('agentParts in every style totals the width; segments, line and gradient look as specified (part 2 #16)', () => {
  for (const style of BAR_STYLE_IDS)
    for (const phase of ['working', 'done'] as const)
      for (const w of [4, 9, 20]) expect(agentParts(style, phase, w, 5, 1).join('').length).toBe(w)
  expect(agentParts('segments', 'done', 4, 0, 0).join('')).toBe('▰▰▰▰')
  expect(agentParts('line', 'working', 12, 3, 0).join('')).toMatch(/^─+━+─+$/)
  expect(agentParts('gradient', 'working', 12, 3, 0).join('')).toMatch(/^░+█+░+$/)
})

// ---- Part 2, acceptance 17: formatting ----

test('model names and durations (part 2 #17)', () => {
  expect(modelShort('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelShort('haiku')).toBe('Haiku')
  expect(modelShort('gpt-x')).toBe('gpt-x')
  expect(modelShort('claude-sonnet-5')).toBe('Sonnet 5')
  expect(elapsed(0)).toBe('0:00')
  expect(elapsed(65)).toBe('1:05')
  expect(elapsed(3725)).toBe('1:02:05')
  expect(elapsed(-4)).toBe('0:00')
})

test('tokens and usage totals', () => {
  expect(tokens(999)).toBe('999')
  expect(tokens(33_500)).toBe('34k')
  expect(tokens(1_200_000)).toBe('1.2M')
  expect(usageTotal({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 30000, cache_creation_input_tokens: 2000 })).toBe(33500)
})

// ---- Part 2, acceptance 18: tool call -> step ----

test('a tool call as a step (part 2 #18)', () => {
  const home = '/home/me'
  expect(stepOf('Read', { file_path: '/home/me/notes/research.md' }, home, nameOf)).toEqual({ kind: 'read', label: 'research.md', dim: '~/notes', live: 'Reading research.md' })
  expect(stepOf('Edit', { file_path: 'C:\\Users\\me\\x\\a.ts' }, 'C:/Users/me', nameOf)).toEqual({ kind: 'write', label: 'a.ts', dim: '~/x', live: 'Editing a.ts' })
  expect(stepOf('Bash', { command: 'ls /tmp', description: 'List the temp folder' }, home, nameOf)).toEqual({ kind: 'command', label: 'List the temp folder', live: 'Running: List the temp folder' })
  expect(stepOf('mcp__1a2b3c4d-0000-1111__search_threads', { query: 'x' }, home, nameOf)).toEqual({ kind: 'connector', label: 'Gmail · search threads', live: 'Gmail: search threads' })
  expect(stepOf('Agent', { description: 'Find invoices' }, home, nameOf).live).toBe('Starting a subagent: Find invoices')
  expect(stepOf('Agent', {}, home, nameOf).live).toBe('Starting a subagent')
  expect(stepOf('Frobnicate', {}, home, nameOf)).toEqual({ kind: 'tool', label: 'Frobnicate', live: 'Using Frobnicate' })
  expect(stepOf('WebFetch', { url: 'https://docs.example.com/a' }, home, nameOf).live).toBe('Opening docs.example.com')
  expect(stepOf('WebFetch', { url: 'nope' }, home, nameOf).label).toBe('a web page')
  expect(stepOf('Grep', { pattern: 'TODO', path: '/home/me/src' }, home, nameOf)).toEqual({ kind: 'read', label: 'Search "TODO"', dim: '~/src', live: 'Searching files for "TODO"' })
  expect(stepOf('Skill', { skill: '/video-prep' }, home, nameOf).live).toBe('Using the video-prep skill')
  expect(stepOf('Write', { file_path: '/home/me/a.md' }, home, nameOf).live).toBe('Writing a.md')
  expect(stepOf('TodoWrite', {}, home, nameOf).label).toBe('Update its to-do list')
  expect(stepWords('slack_search_public', 'Slack')).toBe('search public')
  expect(stepWords('getTranscripts', 'YouTube')).toBe('get transcripts')
})

// ---- Connectors: names, keys, call texts, CLI (part 2 #3, #7) ----

test('server names: hints, memory for id servers, readable names, no raw id (part 2 #7)', () => {
  const mem = new Map<string, string>()
  const id = 'abcdef12-3456-7890'
  expect(serverName(id, 'list_landing_pages', mem)).toBe('Kit')
  expect(serverName(id, 'list_posts', mem)).toBe('Kit')
  expect(serverName('11111111-2222', 'list_spaces', mem)).toBe('Circle')
  expect(serverName('22222222-3333', 'call-actor', mem)).toBe('Apify')
  expect(serverName('33333333-4444', 'notion-search', mem)).toBe('Notion')
  expect(serverName('plugin_demo_fireflies', 'x', mem)).toBe('Fireflies')
  expect(serverName('claude_ai_Slack', 'x', mem)).toBe('Slack')
  expect(serverName('44444444-5555', 'do_something_new', mem)).toBe('Connector')
  expect(serverName('my-tools_server', 'x', mem)).toBe('My Tools Server')
  expect(rowKey('Google Workspace')).toBe('google')
  expect(rowKey('Meta Ads')).toBe('meta')
  expect(hintOf('ads_studio_make')).toBe('Higgsfield')
  expect(hintOf('ads_list')).toBe('Meta Ads')
  expect(hintOf('getTranscripts')).toBe('YouTube')
  expect(hintOf('gettranscripts')).toBeUndefined()
  expect(hintOf('list_recent_files')).toBe('Google Drive')
})

test('call text and summary', () => {
  expect(mcpCallText('fireflies_get_transcripts', 'Fireflies')).toBe('get transcripts')
  expect(mcpCallText('search_threads', 'Gmail')).toBe('search threads')
  expect(mcpCallText('s1_list', 'X')).toBe('list')
  expect(mcpSummary({ tool: 'x', tool_use_id: 't', query: 'invoices  from\nMay' })).toBe('invoices from May')
  expect(mcpSummary({ file_path: '/a/b/c.txt' })).toBe('c.txt')
  expect(mcpSummary({ other: 'thing' })).toBe('thing')
  expect(mcpSummary({ limit: 5 })).toBe('limit 5')
  expect(mcpSummary({ query: 'x'.repeat(80) })).toHaveLength(60)
})

test('Bash CLI connectors in command position only (part 2 #3)', () => {
  expect(parseCli('cd ~; gws gmail users messages list --params \'{"q":"from:bob"}\'')).toEqual([{ name: 'Gmail', text: 'users messages list', summary: 'from:bob' }])
  expect(parseCli('cd ~ && gws calendar events list')).toEqual([{ name: 'Google Calendar', text: 'events list', summary: '' }])
  expect(parseCli('echo gwsx; ls ~/gws')).toEqual([])
  expect(parseCli('FOO=1 firecrawl scrape https://a.example/x')).toEqual([{ name: 'Firecrawl', text: 'scrape', summary: 'https://a.example/x' }])
  expect(parseCli('youtube-pp-cli get-video abc')).toEqual([{ name: 'YouTube', text: 'get video', summary: 'abc' }])
  expect(parseCli('agent-browser <<EOF\nx\nEOF')).toEqual([{ name: 'Browser', text: 'run script', summary: '' }])
  expect(parseCli('gws gmail list; gws gmail list')).toHaveLength(1)
  expect(parseCli('for x in 1; do gws drive files list; done')).toEqual([{ name: 'Google Drive', text: 'files list', summary: '' }])
  expect(parseCli('gws admin')).toEqual([{ name: 'Google Workspace', text: 'admin', summary: '' }])
})

// ---- Inventory ----

test('connector rows merge by key and keep the newest 60 calls', () => {
  let inv = EMPTY_INVENTORY
  for (let i = 0; i < 65; i++) inv = addConnectorCall(inv, 'gmail', 'Gmail', { text: `c${i}`, summary: '', at: null, cli: i === 0 })
  const row = inv.connectors[0]!
  expect(row.count).toBe(65)
  expect(row.calls).toHaveLength(60)
  expect(row.calls.at(-1)?.text).toBe('c64')
  expect([row.cli, row.mcp]).toEqual([true, true])
})

test('files: newest first, memory files below, SKILL.md is a skill; window clamps', () => {
  let inv = addFile(addFile(EMPTY_INVENTORY, '/a/one.md'), '/a/two.md')
  inv = addMemoryFiles(inv, ['/home/me/CLAUDE.md', '/home/me/.claude/skills/foo/SKILL.md'])
  inv = addFile(inv, '/a/one.md')
  expect(filesShown(inv).map(f => f.path)).toEqual(['/a/one.md', '/a/two.md', '/home/me/CLAUDE.md'])
  expect(skillsShown(inv)).toEqual([{ name: 'foo', count: 0, order: 0, always: true }])
  expect(skillsShown(addSkill(inv, 'bar')).map(s => s.name)).toEqual(['bar', 'foo'])
  expect(clampTop(12, 15)).toBe(5)
  expect(clampTop(-3, 15)).toBe(0)
  expect(clampTop(4, 8)).toBe(0)
})

test('paths: home shortening, folders, spill files, skills, transcript', () => {
  expect(homeShort('/home/me/x/y', '/home/me')).toBe('~/x/y')
  expect(homeShort('/home/meg/x', '/home/me')).toBe('/home/meg/x')
  expect(shownFolder('/a.md', '/home/me')).toBe('/')
  expect(shownFolder('/home/me/projects/very-long-folder-name/sub/notes.md', '/home/me')).toBe('…/sub')
  expect(shownFolder('/home/me/x/notes.md', '/home/me')).toBe('~/x')
  expect(isSpill('/tmp/x.txt', '/home/me')).toBe(true)
  expect(isSpill('/home/me/.claude/projects/p/0b1c2d3e-0000-4000-8000-123456789abc/tool-results/a.txt', '/home/me')).toBe(true)
  expect(isSpill('/home/me/.claude/projects/p/0b1c2d3e-0000-4000-8000-123456789abc/x.txt', '/home/me')).toBe(true)
  expect(isSpill('/home/me/notes.md', '/home/me')).toBe(false)
  expect(skillOfPath('/x/skills/foo/SKILL.md')).toBe('foo')
  expect(skillOfPath('/x/foo/README.md')).toBeUndefined()
  expect(transcriptPath('/home/me', '/home/me/repo', 's1')).toBe('/home/me/.claude/projects/-home-me-repo/s1.jsonl')
  const times = transcriptTimes(`${JSON.stringify({ timestamp: '2026-10-31T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'tu1' }] } })}\nnot json\n`)
  expect(times.get('tu1')).toBe(Date.parse('2026-10-31T10:00:00Z'))
})

// ---- The plan and the band ----

test('plan sources: plan tool, TodoWrite, TaskCreate, TaskUpdate', () => {
  let p = applyPlanTool(EMPTY_PLAN, { title: ' Ship it ', steps: [{ text: 'a', status: 'completed' }, { text: '', status: 'pending' }, { text: 'b', status: 'weird' }] })
  expect(p).toEqual({ title: 'Ship it', stamp: 0, steps: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'pending' }] })
  p = applyTodoWrite(p, { todos: [{ content: 'x', status: 'in_progress', activeForm: 'Doing x' }] })
  expect(p.title).toBe('Ship it')
  expect(p.steps).toEqual([{ text: 'x', status: 'in_progress', activeForm: 'Doing x' }])
  let q = applyTaskCreate(EMPTY_PLAN, { subject: 'one' })!
  q = applyTaskCreate(q, { subject: 'two' }, '7')!
  expect(q.steps.map(s => s.id)).toEqual(['1', '7'])
  expect(applyTaskCreate(q, {})).toBeNull()
  expect(applyTaskUpdate(q, { taskId: 7, status: 'completed' })!.steps[1]?.status).toBe('completed')
  expect(applyTaskUpdate(q, { taskId: '1', status: 'deleted' })!.steps.map(s => s.text)).toEqual(['two'])
  expect(applyTaskUpdate(q, { taskId: 99 })).toBeNull()
  const noIds = { ...EMPTY_PLAN, steps: [{ text: 'a', status: 'pending' as const }, { text: 'b', status: 'pending' as const }] }
  expect(applyTaskUpdate(noIds, { taskId: 2, subject: 'B' })!.steps[1]?.text).toBe('B')
})

test('the band flag: shows, hides 20 s after all done, no change when all done again', () => {
  const plan = (statuses: string[], stamp: number) => ({ title: '', stamp, steps: statuses.map(status => ({ text: 'x', status: status as 'pending' })) })
  expect(nextBand({ shown: true, allDone: false, stamp: 0 }, plan([], 1))).toEqual({ band: { shown: false, allDone: false, stamp: 1 }, timer: 'cancel' })
  expect(nextBand({ shown: false, allDone: false, stamp: 0 }, plan(['completed', 'pending'], 1)).band.shown).toBe(true)
  expect(nextBand({ shown: true, allDone: false, stamp: 1 }, plan(['completed', 'completed'], 2))).toEqual({ band: { shown: true, allDone: true, stamp: 2 }, timer: 'start' })
  expect(nextBand({ shown: false, allDone: true, stamp: 2 }, plan(['completed', 'completed'], 3))).toEqual({ band: { shown: false, allDone: true, stamp: 3 }, timer: 'keep' })
  expect(bandNote(plan(['completed', 'pending'], 1))).toBe('Next: x')
  expect(bandNote(plan(['completed'], 1))).toBe('All steps done')
})

test('band colours: ids in order, mix, counts and the desktop drawing', () => {
  expect([...BAND_COLOR_IDS]).toEqual(['purple', 'green', 'burgundy', 'navy', 'orange'])
  expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  expect(mix('#c4b5fd', '#6d28d9', 0)).toBe('#c4b5fd')
  expect(mix('#c4b5fd', '#6d28d9', 1)).toBe('#6d28d9')
  expect(bandColorOf('pink')).toBe('purple')
  expect(bandCounts({ done: 2, total: 4 })).toEqual({ count: 'Tasks 2/4', percent: '50%' })
  const svg = bandSvg({ title: 'Ship <it>', done: 2, total: 4, isLive: true, liveIndex: 2 }, 'navy', 400)
  expect(svg).toContain('Tasks 2/4')
  expect(svg).toContain('prefers-reduced-motion')
  expect(svg).toContain('Ship &lt;it&gt;')
})

test('wrap: at spaces, long words hard-split, at least 8 wide', () => {
  expect(wrap('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc'])
  expect(wrap('abcdefghijkl', 8)).toEqual(['abcdefgh', 'ijkl'])
  expect(wrap('a b', 2)).toEqual(['a b'])
})

// ---- Cards ----

const card = (id: string, phase: Card['phase'], color = 0): Card => ({
  id, description: id, type: 't', model: '', effort: '', phase, startMs: 0, calls: 0, steps: [], tokens: 0, turnTokens: 0, usageSeen: false, seat: 0, color,
})

test('card colours: running cards never share one while there are at most 8', () => {
  expect(pickColor(-1, [])).toBe(0)
  expect(pickColor(0, [1, 2])).toBe(3)
  expect(pickColor(7, [0])).toBe(1)
  expect(pickColor(3, [0, 1, 2, 3, 4, 5, 6, 7])).toBe(4)
})

test('at most 30 finished cards kept; running ones never dropped', () => {
  const cards = [card('run', 'working'), ...Array.from({ length: 35 }, (_, i) => card(`f${i}`, i % 2 ? 'done' : 'failed'))]
  const kept = pruneCards(cards)
  expect(kept).toHaveLength(31)
  expect(kept[0]?.id).toBe('run')
  expect(kept[1]?.id).toBe('f5')
})

// ---- Background ----

const entry = (port: number, image: string, minutes = 5): Listener => ({ key: `port:${port}:1`, label: 'x', port, pid: 1, pids: [1], count: 1, image, since: 0, minutes })

test('port groups: by label, ordered by lowest port; up, idle, foreign', () => {
  const watched = { 8090: 'backend', 8091: 'backend', 5005: 'debug', 4200: 'frontend', 4201: 'frontend' }
  const groups = portGroups(watched, [entry(8090, 'java.exe'), entry(4200, 'svchost.exe'), entry(5005, '?')])
  expect(groups.map(g => g.label)).toEqual(['frontend', 'debug', 'backend'])
  expect(groups[0]?.ports.map(p => [p.port, p.state])).toEqual([
    [4200, 'foreign'],
    [4201, 'idle'],
  ])
  expect(groups[1]?.ports[0]?.state).toBe('up')
  expect(groups[2]?.ports.map(p => p.state)).toEqual(['up', 'idle'])
  expect(portGroups({ 1: 'a' }, [entry(1, 'NODE')])[0]?.ports[0]?.state).toBe('up')
})

test('background line', () => {
  expect(backgroundLine({ label: 'backend', port: 8090, count: 1 })).toBe('backend :8090')
  expect(backgroundLine({ label: 'backend tests (surefire)', count: 3, progress: { done: 412, total: 924 } })).toBe('backend tests (surefire) ×3 412/924')
  expect(backgroundLine({ label: 'vitest', count: 2, progress: { done: 40 } })).toBe('vitest ×2 40')
  expect(backgroundLine({ label: 'v', count: 1, progress: { done: 50, total: 40 } })).toBe('v 50')
})

// ---- Switches and settings ----

test('switches: off is exactly false, hidden exactly true, anything else neither', () => {
  expect(switchesOf({ 'chat-sidecar': false })).toEqual({ off: true, hidden: false })
  expect(switchesOf({ 'chat-sidecar': 'false', 'chat-sidecar:hidden': 1 })).toEqual({ off: false, hidden: false })
  expect(switchesOf({ 'chat-sidecar:hidden': true })).toEqual({ off: false, hidden: true })
  expect(switchesOf([false])).toEqual({ off: false, hidden: false })
  expect(switchesOf(null)).toEqual({ off: false, hidden: false })
})

test('ports check', () => {
  expect(badPorts('9000=api, oops')).toEqual(['oops'])
  expect(badPorts('9000=api; 70000=x 1=y')).toEqual(['70000=x'])
  expect(badPorts('')).toEqual([])
})
