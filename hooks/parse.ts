import { BAND_COLOR_IDS } from './band'
import type { BandColor } from './band'
import { BAR_STYLE_IDS } from './barstyle'
import type { BarStyle } from './barstyle'
export type Found = { port: number; label: string; pid: number; image?: string }
export type Proc = { pid: number; image: string; cmd: string }

// `netstat -ano` (Windows): "  TCP    0.0.0.0:8090    0.0.0.0:0    LISTENING    36764", IPv6 rows as "[::1]:4201".
// The state word is translated on a localized Windows (Polish: NASŁUCHIWANIE), so a listening socket
// is told by its foreign address instead: only a listener has 0.0.0.0:0 or [::]:0 there
export function parseListeners(stdout: string, watched: Record<number, string>): Found[] {
  const seen = new Set<string>()
  const found: Found[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S*:(\d+)\s+(?:0\.0\.0\.0|\[::\]):0\s+\S+\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    const port = Number(m[1])
    const pid = Number(m[2])
    const label = watched[port]
    // IPv4 and IPv6 rows of one server are one entry
    if (!label || seen.has(`${port}/${pid}`)) continue
    seen.add(`${port}/${pid}`)
    found.push({ port, label, pid })
  }
  return found.sort((a, b) => a.port - b.port)
}

// `ss -Hltnp` (Linux): 'LISTEN 0 100 *:8090 *:* users:(("java",pid=36764,fd=45))', IPv6 as "[::1]:4201";
// a socket of another user's process has no users:(...) without root and is skipped
export function parseSs(stdout: string, watched: Record<number, string>): Found[] {
  const seen = new Set<string>()
  const found: Found[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^LISTEN\s+\d+\s+\d+\s+\S*:(\d+)\s+\S+\s+users:\(\("([^"]+)",pid=(\d+)/.exec(line)
    if (!m) continue
    const port = Number(m[1])
    const pid = Number(m[3])
    const label = watched[port]
    if (!label || seen.has(`${port}/${pid}`)) continue
    seen.add(`${port}/${pid}`)
    found.push({ port, label, pid, image: m[2] })
  }
  return found.sort((a, b) => a.port - b.port)
}

// `ps -eo pid=,comm=,args=` (Linux): "  36764 java            /usr/bin/java -jar app.jar"; only java and node, as on Windows
export function parsePs(stdout: string): Proc[] {
  const procs: Proc[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (m && (m[2] === 'java' || m[2] === 'node')) procs.push({ pid: Number(m[1]), image: m[2], cmd: m[3] ?? '' })
  }
  return procs
}

// `tasklist /FO CSV /NH /FI "PID eq N"`: "\"java.exe\",\"36764\",\"Console\",\"1\",\"812 000 K\""
export function parseTasklist(stdout: string): string {
  const m = /^"([^"]+)"/m.exec(stdout)
  return m?.[1] ?? '?'
}

// `Get-CimInstance Win32_Process | ... | ConvertTo-Json -Compress`: one object, an array, or nothing at all
export function parseProcesses(stdout: string): Proc[] {
  if (!stdout.trim()) return []
  try {
    const raw: unknown = JSON.parse(stdout)
    const rows = (Array.isArray(raw) ? raw : [raw]) as { ProcessId?: number; Name?: string; CommandLine?: string | null }[]
    return rows
      .filter(r => typeof r.ProcessId === 'number')
      .map(r => ({ pid: r.ProcessId as number, image: r.Name ?? '?', cmd: r.CommandLine ?? '' }))
  } catch {
    return []
  }
}

// First match wins; add a pattern when a new kind of background job shows up.
/** The label of surefire's forked JVMs; `poll` looks for it to show the run's progress. */
export const SUREFIRE = 'backend tests (surefire)'

const KINDS: { label: string; test: (cmd: string) => boolean }[] = [
  { label: SUREFIRE, test: c => /surefire\.booter\.ForkedBooter|surefirebooter/i.test(c) },
  {
    label: 'mvn test',
    test: c => /classworlds\.launcher\.Launcher/.test(c) && /(\s|")(test|verify)(\s|"|$)|\s-Dtest=/.test(c),
  },
  { label: 'frontend tests', test: c => /(^|[\\/\s])ng(\.js)?"?\s+test(\s|$)|[\\/]vitest[\\/]|\svitest(\s|$)/.test(c) },
]

/** The label of a background job worth showing, or null for anything else (IDE helpers, servers seen by port). */
export function classify(cmd: string): string | null {
  return KINDS.find(k => k.test(cmd))?.label ?? null
}

/** The project a Maven run builds, and whether it runs only some tests (`-Dtest=`), so the last full total does not apply. */
export type MavenRun = { root: string; partial: boolean }

// the Maven launcher names its project in `-Dmaven.multiModuleProjectDirectory=`: quoted whole on Windows
// (`"-D...=C:\a b"`), bare on Linux. Limit: a Linux path with spaces is cut at the first one
export function mavenRun(cmd: string): MavenRun | null {
  if (!/classworlds\.launcher\.Launcher/.test(cmd)) return null
  const m = /"-Dmaven\.multiModuleProjectDirectory=([^"]+)"|-Dmaven\.multiModuleProjectDirectory=(\S+)/.exec(cmd)
  const root = (m?.[1] ?? m?.[2])?.replace(/[\\/]+$/, '')
  return root ? { root, partial: /(\s|")-Dtest=/.test(cmd) } : null
}

/** `Tests run: 4, Failures: 0, ...` from a surefire `<class>.txt` report; 0 when the file has no such line. */
export function testsRun(report: string): number {
  return Number(/Tests run: (\d+)/.exec(report)?.[1] ?? 0)
}

/**
 * The total to remember after a full run that got `done` tests through. A run cut short (Ctrl+C, a crash) must not
 * shrink the total for good, so a much smaller count keeps the old one; deleted tests still lower it.
 */
export function nextTotal(prior: number | undefined, done: number): number | undefined {
  if (done <= 0) return prior
  return prior === undefined || done >= prior * 0.8 ? done : prior
}

/** `▓▓▓▓░░░░░░` for done of total, `width` cells, full only when done reaches total. */
export function bar(done: number, total: number, width = 10): string {
  const filled = Math.min(width, Math.floor((done / total) * width))
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

/** Age thresholds in minutes; servers never turn red. */
export type Age = { test: { warning: number; error: number }; server: { warning: number; error: number } }

/** The pane's sections, in their default order; `show<Name>` in userConfig turns each on or off. */
export const SECTION_IDS = ['todo', 'tasks', 'subagents', 'background', 'connectors', 'files', 'skills', 'git'] as const
export type SectionId = (typeof SECTION_IDS)[number]
export const SHOW_FIELD: Record<SectionId, string> = {
  todo: 'showTodo',
  tasks: 'showTasks',
  subagents: 'showSubagents',
  background: 'showBackground',
  connectors: 'showConnectors',
  files: 'showFiles',
  skills: 'showSkills',
  git: 'showGit',
}
// Keep in step with the defaults in plugin.json: the settings screen's Reset writes these.
export const DEFAULT_ORDER = SECTION_IDS.join(', ')
export const DEFAULT_PORTS = '8090=backend, 8091=backend, 5005=debug, 4200=frontend, 4201=frontend'
export type Sections = { order: SectionId[]; shown: Record<SectionId, boolean> }

/** `sectionOrder` as a full order: unknown and repeated ids skipped, missing ones appended in the default order. */
export function parseOrder(text: string): { order: SectionId[]; bad: string[] } {
  const order: SectionId[] = []
  const bad: string[] = []
  for (const token of text.split(/[,;\s]+/).filter(Boolean)) {
    const id = token.toLowerCase() as SectionId
    if (!SECTION_IDS.includes(id)) bad.push(token)
    else if (!order.includes(id)) order.push(id)
  }
  return { order: [...order, ...SECTION_IDS.filter(id => !order.includes(id))], bad }
}

/** What the mod runs on, read from its `userConfig` options (plugin.json declares them and their defaults). */
export type Settings = {
  sections: Sections
  /** The plan band's colour, a key of BAND_COLORS. */
  bandColor: BandColor
  /** The terminal's bar style for the plan band and the subagent cards, one of BAR_STYLE_IDS. */
  barStyle: BarStyle
  watched: Record<number, string>
  pollMs: number
  jobsMs: number
  age: Age
  /** Option values that were not understood and were skipped or replaced, for the debug log. */
  problems: string[]
}

/** `8090=backend, 4200=frontend` (commas, semicolons or spaces between entries) as a port → label map. */
export function parsePorts(text: string): { watched: Record<number, string>; bad: string[] } {
  const watched: Record<number, string> = {}
  const bad: string[] = []
  for (const token of text.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d{1,5})=(\S+)$/.exec(token)
    const port = Number(m?.[1])
    if (m?.[2] && port >= 1 && port <= 65535) watched[port] = m[2]
    else bad.push(token)
  }
  return { watched, bad }
}

/** The settings from the options as `register` receives them; a value out of range falls back to its floor or default. */
export function settings(options: Readonly<Record<string, unknown>>): Settings {
  const problems: string[] = []
  const num = (key: string, fallback: number, min: number): number => {
    const v = Number(options[key] ?? fallback)
    if (!Number.isFinite(v)) {
      problems.push(`${key}: ${String(options[key])} is not a number, ${fallback} used`)
      return fallback
    }
    if (v < min) problems.push(`${key}: ${v} is below ${min}, ${min} used`)
    return Math.max(v, min)
  }

  const { watched, bad } = parsePorts(String(options.ports ?? ''))
  if (bad.length > 0) problems.push(`ports: skipped ${bad.join(' ')} (expected port=label)`)

  const { order, bad: badIds } = parseOrder(String(options.sectionOrder ?? DEFAULT_ORDER))
  if (badIds.length > 0) problems.push(`sectionOrder: skipped ${badIds.join(' ')} (unknown section)`)
  const shown = Object.fromEntries(SECTION_IDS.map(id => [id, options[SHOW_FIELD[id]] !== false])) as Record<SectionId, boolean>

  const color = String(options.bandColor ?? 'purple')
  const bandColor: BandColor = BAND_COLOR_IDS.includes(color as BandColor) ? (color as BandColor) : 'purple'
  if (bandColor !== color) problems.push(`bandColor: ${color} is not one of ${BAND_COLOR_IDS.join(', ')}, purple used`)
  const bar = String(options.barStyle ?? 'gradient')
  const barStyle: BarStyle = BAR_STYLE_IDS.includes(bar as BarStyle) ? (bar as BarStyle) : 'gradient'
  if (barStyle !== bar) problems.push(`barStyle: ${bar} is not one of ${BAR_STYLE_IDS.join(', ')}, gradient used`)

  const pollSeconds = num('pollSeconds', 10, 2)
  return {
    sections: { order, shown },
    bandColor,
    barStyle,
    watched,
    pollMs: pollSeconds * 1000,
    // the expensive scan never runs more often than the port check that carries it
    jobsMs: num('jobsSeconds', 30, pollSeconds) * 1000,
    age: {
      test: { warning: num('testWarnMinutes', 15, 1), error: num('testErrorMinutes', 30, 1) },
      server: { warning: num('serverWarnHours', 8, 0.1) * 60, error: Infinity },
    },
    problems,
  }
}

export const DEFAULT_AGE: Age = settings({}).age

/** How worrying an entry's age is: tests that run long may hang, servers left for hours may be forgotten. */
export function level(entry: { port?: number; minutes: number }, age: Age = DEFAULT_AGE): 'ok' | 'warning' | 'error' {
  const limits = entry.port ? age.server : age.test
  if (entry.minutes >= limits.error) return 'error'
  if (entry.minutes >= limits.warning) return 'warning'
  return 'ok'
}

/** Minutes as `12m` or `1h05m`. */
export function ago(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}
