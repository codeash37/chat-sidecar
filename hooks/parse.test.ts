import { expect, test } from 'claude-code/testing'

import {
  ago,
  bar,
  classify,
  level,
  mavenRun,
  nextTotal,
  parseListeners,
  parseOrder,
  parsePorts,
  parseProcesses,
  parsePs,
  parseSs,
  parseTasklist,
  settings,
  testsRun,
} from './parse'

const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234',
  '  TCP    0.0.0.0:8090           0.0.0.0:0              LISTENING       36764',
  '  TCP    127.0.0.1:52000        127.0.0.1:8090         ESTABLISHED     999',
  '  TCP    [::]:8090              [::]:0                 LISTENING       36764',
  '  TCP    [::1]:4201             [::]:0                 LISTENING       38532',
  '  UDP    0.0.0.0:4201           *:*                                    777',
].join('\r\n')

test('lists only watched listening ports, one entry per server, IPv6 included', () => {
  expect(parseListeners(NETSTAT, { 8090: 'backend', 4201: 'frontend' })).toEqual([
    { port: 4201, label: 'frontend', pid: 38532 },
    { port: 8090, label: 'backend', pid: 36764 },
  ])
})

test('nothing watched is listening', () => {
  expect(parseListeners(NETSTAT, { 4200: 'frontend' })).toEqual([])
})

test('reads the image name from tasklist csv', () => {
  expect(parseTasklist('"java.exe","36764","Console","1","812 000 K"\r\n')).toBe('java.exe')
  expect(parseTasklist('INFO: No tasks are running which match the specified criteria.')).toBe('?')
})

test('reads ConvertTo-Json as a single object, an array, or nothing', () => {
  expect(parseProcesses('{"ProcessId":1,"Name":"java.exe","CommandLine":"x"}')).toEqual([
    { pid: 1, image: 'java.exe', cmd: 'x' },
  ])
  expect(parseProcesses('[{"ProcessId":1,"Name":"a","CommandLine":null},{"ProcessId":2,"Name":"b"}]')).toEqual([
    { pid: 1, image: 'a', cmd: '' },
    { pid: 2, image: 'b', cmd: '' },
  ])
  expect(parseProcesses('')).toEqual([])
  expect(parseProcesses('not json')).toEqual([])
})

// command lines as seen on this machine (shortened)
const MVN = 'C:\\jdk\\bin\\java.exe -classpath boot\\plexus-classworlds-2.8.0.jar org.codehaus.plexus.classworlds.launcher.Launcher'
const FORK =
  'C:\\jdk\\bin\\java.exe -jar C:\\x\\backend\\target\\surefire\\surefirebooter123.jar C:\\x\\target\\surefire 2026-10-05T12 surefire_0'

test('classifies test runs', () => {
  expect(classify(`${MVN} -B test -Dtest=FooTest`)).toBe('mvn test')
  expect(classify(`${MVN} -f backend/pom.xml -Dtest=FooTest test`)).toBe('mvn test')
  expect(classify(`${MVN} verify`)).toBe('mvn test')
  expect(classify(FORK)).toBe('backend tests (surefire)')
  expect(classify('node "C:\\x\\node_modules\\@angular\\cli\\bin\\ng.js" test --no-watch')).toBe('frontend tests')
  expect(classify('node C:\\x\\node_modules\\vitest\\dist\\workers\\forks.js')).toBe('frontend tests')
})

test('ignores servers, other maven goals and IDE helpers', () => {
  expect(classify(`${MVN} -B -q -f backend/pom.xml spring-boot:run -Dmaven.gitcommitid.skip=true`)).toBeNull()
  expect(classify(`${MVN} clean package -DskipTests`)).toBeNull()
  expect(classify('node "C:\\x\\node_modules\\@angular\\cli\\bin\\ng.js" serve --port 4201')).toBeNull()
  expect(classify('java.exe -cp idea.jar org.jetbrains.idea.maven.server.RemoteMavenServer36')).toBeNull()
  expect(classify('java.exe -cp x oracle.dbtools.raptor.scriptrunner.cmdline.SqlCli -mcp')).toBeNull()
})

const SS = [
  'LISTEN 0      4096         127.0.0.53%lo:53         0.0.0.0:*',
  'LISTEN 0      100                      *:8090             *:*    users:(("java",pid=36764,fd=45))',
  'LISTEN 0      100                   [::]:8090          [::]:*    users:(("java",pid=36764,fd=46))',
  'LISTEN 0      511                  [::1]:4201          [::]:*    users:(("node",pid=38532,fd=23))',
  'LISTEN 0      511                0.0.0.0:4200       0.0.0.0:*',
].join('\n')

test('linux: lists watched ports from ss with their image, skips sockets without a pid', () => {
  expect(parseSs(SS, { 8090: 'backend', 4200: 'frontend', 4201: 'frontend' })).toEqual([
    { port: 4201, label: 'frontend', pid: 38532, image: 'node' },
    { port: 8090, label: 'backend', pid: 36764, image: 'java' },
  ])
})

test('linux: reads java and node processes from ps, command line kept whole', () => {
  const PS = [
    '      1 systemd         /sbin/init splash',
    '  36764 java            /usr/lib/jvm/bin/java -jar /x/target/surefire/surefirebooter1.jar /x surefire_0',
    '  38532 node            node /x/node_modules/.bin/ng test --no-watch',
  ].join('\n')
  const procs = parsePs(PS)
  expect(procs.map(p => [p.pid, p.image])).toEqual([[36764, 'java'], [38532, 'node']])
  expect(procs.map(p => classify(p.cmd))).toEqual(['backend tests (surefire)', 'frontend tests'])
  expect(classify('node /x/node_modules/.bin/ng serve --port 4201')).toBeNull()
})

test('age levels: tests turn yellow at 15 min and red at 30, servers yellow after 8 h', () => {
  expect([0, 14, 15, 29, 30].map(minutes => level({ minutes }))).toEqual(['ok', 'ok', 'warning', 'warning', 'error'])
  expect([60, 479, 480, 5000].map(minutes => level({ port: 8090, minutes }))).toEqual(['ok', 'ok', 'warning', 'warning'])
})

test('formats minutes', () => {
  expect([0, 59, 60, 125].map(ago)).toEqual(['0m', '59m', '1h00m', '2h05m'])
})

test('localized netstat: a listener is told by its foreign address, not by the state word', () => {
  const PL = [
    '  TCP    0.0.0.0:8090           0.0.0.0:0              NASŁUCHIWANIE   36764',
    '  TCP    127.0.0.1:8090         127.0.0.1:52000        USTANOWIONO     36764',
    '  TCP    [::]:4201              [::]:0                 NASŁUCHIWANIE   38532',
  ].join('\r\n')
  expect(parseListeners(PL, { 8090: 'backend', 4201: 'frontend' })).toEqual([
    { port: 4201, label: 'frontend', pid: 38532 },
    { port: 8090, label: 'backend', pid: 36764 },
  ])
})

test('ports option: port=label entries, bad ones skipped and named', () => {
  expect(parsePorts('8090=backend, 4200=frontend;5005=debug  9000=api')).toEqual({
    watched: { 8090: 'backend', 4200: 'frontend', 5005: 'debug', 9000: 'api' },
    bad: [],
  })
  expect(parsePorts('8090=backend, 8091, x=y, 70000=big, 8092=')).toEqual({
    watched: { 8090: 'backend' },
    bad: ['8091', 'x=y', '70000=big', '8092='],
  })
})

test('settings: defaults from nothing, floors kept, problems said', () => {
  const d = settings({})
  expect([d.pollMs, d.jobsMs, d.age.test.warning, d.age.test.error, d.age.server.warning]).toEqual([10_000, 30_000, 15, 30, 480])

  const s = settings({ ports: '9000=api, oops', pollSeconds: 1, jobsSeconds: 0, testWarnMinutes: 20 })
  expect(s.watched).toEqual({ 9000: 'api' })
  // polling below 2 s is raised to 2; the job scan never more often than the port check
  expect([s.pollMs, s.jobsMs, s.age.test.warning]).toEqual([2000, 2000, 20])
  expect(s.problems).toHaveLength(3)
})

test('maven run: project from the launcher, quoted on Windows, bare on Linux; -Dtest marks a partial run', () => {
  const win =
    'java.exe -classpath "C:\\m\\boot\\plexus-classworlds.jar" "-Dmaven.multiModuleProjectDirectory=C:\\dev\\map core\\" org.codehaus.plexus.classworlds.launcher.Launcher clean install'
  expect(mavenRun(win)).toEqual({ root: 'C:\\dev\\map core', partial: false })
  const linux = '/usr/bin/java -Dmaven.multiModuleProjectDirectory=/home/me/shop-api org.codehaus.plexus.classworlds.launcher.Launcher test -Dtest=FooTest'
  expect(mavenRun(linux)).toEqual({ root: '/home/me/shop-api', partial: true })
  expect(mavenRun('java.exe -jar C:\\x\\surefirebooter1.jar')).toBeNull()
})

test('tests run from a surefire txt report', () => {
  expect(testsRun('Test set: a.FooTest\r\nTests run: 35, Failures: 1, Errors: 0, Skipped: 2, Time elapsed: 1 s -- in a.FooTest')).toBe(35)
  expect(testsRun('')).toBe(0)
})

test('remembered total: first full run sets it, a run cut short keeps it, fewer tests lower it', () => {
  expect(nextTotal(undefined, 924)).toBe(924)
  expect(nextTotal(924, 120)).toBe(924)
  expect(nextTotal(924, 900)).toBe(900)
  expect(nextTotal(924, 0)).toBe(924)
})

test('bar: cells filled by share, full only at the total', () => {
  expect(bar(0, 924)).toBe('░░░░░░░░░░')
  expect(bar(412, 924)).toBe('▓▓▓▓░░░░░░')
  expect(bar(923, 924)).toBe('▓▓▓▓▓▓▓▓▓░')
  expect(bar(924, 924)).toBe('▓▓▓▓▓▓▓▓▓▓')
})

test('sections: default order all on; unknown and repeated ids skipped, missing ones last; off only when false', () => {
  const d = settings({})
  expect(d.sections.order).toEqual(['todo', 'tasks', 'subagents', 'background', 'connectors', 'files', 'skills', 'git'])
  expect(Object.values(d.sections.shown).every(Boolean)).toBe(true)

  expect(parseOrder('skills, Todo; bogus todo')).toEqual({ order: ['skills', 'todo', 'tasks', 'subagents', 'background', 'connectors', 'files', 'git'], bad: ['bogus'] })
  expect(parseOrder('').order).toHaveLength(8)
  // A saved order from before Git gets it last.
  expect(parseOrder('todo, tasks, subagents, background, connectors, files, skills').order.at(-1)).toBe('git')

  const s = settings({ sectionOrder: 'background nope', showSkills: false, showTodo: 'false', showFiles: undefined })
  expect(s.sections.order[0]).toBe('background')
  expect(s.sections.shown.skills).toBe(false)
  // only a real false turns a section off: a broken value keeps it drawn
  expect([s.sections.shown.todo, s.sections.shown.files]).toEqual([true, true])
  expect(s.problems).toEqual(['sectionOrder: skipped nope (unknown section)'])

  const none = settings({ showTodo: false, showTasks: false, showSubagents: false, showBackground: false, showConnectors: false, showFiles: false, showSkills: false, showGit: false })
  expect(Object.values(none.sections.shown).some(Boolean)).toBe(false)
})

test('barStyle: gradient by default, a known style kept, an unknown one replaced and said', () => {
  expect(settings({}).barStyle).toBe('gradient')
  expect(settings({ barStyle: 'pixel' }).barStyle).toBe('pixel')
  const s = settings({ barStyle: 'wavy' })
  expect(s.barStyle).toBe('gradient')
  expect(s.problems).toEqual(['barStyle: wavy is not one of gradient, segments, line, dots, pixel, gradient used'])
})

test('bandColor: purple by default, a known colour kept, an unknown one replaced and said', () => {
  expect(settings({}).bandColor).toBe('purple')
  expect(settings({ bandColor: 'navy' }).bandColor).toBe('navy')
  const s = settings({ bandColor: 'pink' })
  expect(s.bandColor).toBe('purple')
  expect(s.problems).toEqual(['bandColor: pink is not one of purple, green, burgundy, navy, orange, purple used'])
})
