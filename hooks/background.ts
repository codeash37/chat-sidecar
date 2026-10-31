import type { EngineInterface } from 'claude-code'

import type { Listener } from '../types'
import { SUREFIRE, classify, mavenRun, nextTotal, parseListeners, parseProcesses, parsePs, parseSs, parseTasklist, testsRun } from './parse'
import type { MavenRun, Settings } from './parse'

// Servers on the watched ports and test runs, for the Background section.
// Ports are cheap to read (netstat ~0.1 s); the process scan is not (PowerShell ~1.3 s, ~1 s of CPU on Windows).

// No double quotes inside: the argv is passed to powershell.exe without a shell
const PS_PROCESSES =
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'java.exe','node.exe' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"

type Seen = Omit<Listener, 'since' | 'minutes' | 'progress'>

/** Runs a command; null when it could not start, timed out or failed, said in the debug log (`claude --debug`). */
async function run($: EngineInterface, argv: string[], timeoutMs: number): Promise<string | null> {
  const r = await $.process.run(argv, { timeoutMs }).catch((err: unknown) => {
    $.ui.log(`${argv[0]} did not run: ${String(err)}`, { to: 'debug' })
    return null
  })
  if (r && r.exitCode !== 0) $.ui.log(`${argv[0]} exited ${r.exitCode}: ${r.stderr.slice(0, 200)}`, { to: 'debug' })
  return r && r.exitCode === 0 ? r.stdout : null
}

// null means the scan failed, which is not the same as "nothing listens": the caller keeps what it had
async function servers($: EngineInterface, cfg: Settings, windows: boolean, prev: Listener[]): Promise<Seen[] | null> {
  // no `-p TCP` on Windows: that lists IPv4 only, and ng serve listens on [::1] alone
  const out = await run($, windows ? ['netstat', '-ano'] : ['ss', '-Hltnp'], 15_000)
  if (out === null) return null

  const seen: Seen[] = []
  for (const f of windows ? parseListeners(out, cfg.watched) : parseSs(out, cfg.watched)) {
    const key = `port:${f.port}:${f.pid}`
    let image = f.image ?? prev.find(p => p.key === key && p.image !== '?')?.image
    if (!image) {
      const t = await run($, ['tasklist', '/FO', 'CSV', '/NH', '/FI', `PID eq ${f.pid}`], 10_000)
      image = t === null ? '?' : parseTasklist(t)
    }
    seen.push({ key, label: f.label, port: f.port, pid: f.pid, pids: [f.pid], count: 1, image })
  }
  return seen
}

async function jobs($: EngineInterface, windows: boolean): Promise<{ seen: Seen[]; mvn: MavenRun | null } | null> {
  const argv = windows
    ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', PS_PROCESSES]
    : ['ps', '-eo', 'pid=,comm=,args=']
  const out = await run($, argv, 20_000)
  if (out === null) return null

  // one entry per kind: a surefire run forks several JVMs, ng test several vitest workers
  const groups = new Map<string, Seen>()
  // Limit: with Maven running in two projects at once the progress follows the first one listed
  let mvn: MavenRun | null = null
  for (const p of windows ? parseProcesses(out) : parsePs(out)) {
    mvn ??= mavenRun(p.cmd)
    const label = classify(p.cmd)
    if (!label) continue
    const g = groups.get(label)
    if (g) {
      g.count += 1
      g.pid = Math.min(g.pid, p.pid)
      g.pids.push(p.pid)
    } else {
      groups.set(label, { key: `proc:${label}`, label, pid: p.pid, pids: [p.pid], count: 1, image: p.image })
    }
  }
  return { seen: [...groups.values()], mvn }
}

// a surefire report is read once: it is written when its test class is done and not touched after
const reports = new Map<string, { mtimeMs: number; tests: number }>()

/** Tests finished since `startMs`, counted from the per-class `<class>.txt` reports (small, unlike the xml ones). */
async function testsDone($: EngineInterface, root: string, startMs: number): Promise<number | null> {
  const dir = `${root}/target/surefire-reports`
  // no folder yet (compiling, or `clean` just ran) is nothing done, not an error
  const entries = await $.fs.list(dir).catch(() => null)
  if (!entries) return null
  let done = 0
  for (const f of entries) {
    // older reports are a previous run's, still there after a `-Dtest=` run without `clean`
    if (f.kind !== 'file' || !f.name.endsWith('.txt') || f.mtimeMs < startMs) continue
    const path = `${dir}/${f.name}`
    let hit = reports.get(path)
    if (hit?.mtimeMs !== f.mtimeMs) {
      const text = await $.fs.read(path).catch(() => '')
      hit = { mtimeMs: f.mtimeMs, tests: testsRun(text) }
      reports.set(path, hit)
    }
    done += hit.tests
  }
  return done
}

const totalKey = (root: string) => `total:${root.toLowerCase()}`

// a store that cannot be read or written costs the bar its total, never the whole section
async function storedTotal($: EngineInterface, root: string): Promise<number | undefined> {
  const v = await $.store.get(totalKey(root)).catch(() => undefined)
  return typeof v === 'number' ? v : undefined
}

let polling = false
let lastJobs: Seen[] = []
let lastMvn: MavenRun | null = null
let jobsAt = -Infinity
/** The surefire run being watched, so its count can become the remembered total once it is gone. */
let watched: { mvn: MavenRun; done: number } | null = null

/**
 * One scan: ports on every call, processes once `cfg.jobsMs` has passed. Gives the new list when something visible
 * changed and null otherwise; the caller writes it, since the pane redraws on writes through its own atom.
 */
export async function poll($: EngineInterface, cfg: Settings, windows: boolean, prev: Listener[]): Promise<Listener[] | null> {
  // a slow scan (busy machine, PowerShell near its timeout) must not stack up behind the timer
  if (polling) return null
  polling = true
  try {
    const now = await $.clock.now()
    const isJobsDue = now - jobsAt >= cfg.jobsMs
    const [scanned, ran] = await Promise.all([servers($, cfg, windows, prev), isJobsDue ? jobs($, windows) : null])
    // a failed scan keeps the last entries, so they neither blink out nor restart their age;
    // a failed job scan is retried on the next tick
    const s = scanned ?? prev.filter(p => p.port)
    if (ran) {
      lastJobs = ran.seen
      lastMvn = ran.mvn
      jobsAt = now
    }

    const current: Listener[] = [...s, ...lastJobs].map(e => {
      const before = prev.find(p => p.key === e.key)
      // the next `mvn test` of a TDD loop is a new run although its label is the same: no pid carried over
      const isSameRun = before && (e.port || e.pids.some(pid => before.pids.includes(pid)))
      const since = isSameRun ? before.since : now
      return { ...e, since, minutes: Math.floor((now - since) / 60_000) }
    })

    const surefire = current.find(l => l.label === SUREFIRE)
    if (surefire && lastMvn) {
      // the forks are seen up to one process scan after they start; a class may finish in that time
      const done = await testsDone($, lastMvn.root, surefire.since - cfg.jobsMs)
      if (done !== null) {
        const total = lastMvn.partial ? undefined : await storedTotal($, lastMvn.root)
        surefire.progress = { done, total }
        watched = { mvn: lastMvn, done }
      }
    } else if (watched) {
      // the run is over: its count is the total the next full run is measured against
      if (!watched.mvn.partial) {
        const total = nextTotal(await storedTotal($, watched.mvn.root), watched.done)
        if (total !== undefined) {
          await $.store.set(totalKey(watched.mvn.root), total).catch((err: unknown) => {
            $.ui.log(`store.set failed: ${String(err)}`, { to: 'debug' })
          })
        }
      }
      watched = null
      reports.clear()
    }

    // writes redraw the pane, so only hand back a change (at most once a minute when idle)
    return JSON.stringify(current) !== JSON.stringify(prev) ? current : null
  } catch (err) {
    // the next tick tries again
    $.ui.log(`poll failed: ${String(err)}`, { to: 'debug' })
    return null
  } finally {
    polling = false
  }
}
