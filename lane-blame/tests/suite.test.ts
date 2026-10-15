import { expect, test } from 'claude-code/testing'
import type { AgentInfo, On, TurnCompleteInput } from 'claude-code'

const LOG = '/tmp/suite-shadow-repo.log'
// the sentinel path for the tree /repo under the old harness prefix: printf '%s' /repo | sha256sum | cut -c1-16
const SENTINEL = '/tmp/canon-declared-red-816fc349d3faebf8'
// the same for the worktree /repo/.claude/worktrees/agent-x
const TREE_SENTINEL = '/tmp/canon-declared-red-db5cacb7c2dafd30'
// the old harness's sentinel and gate options, set by the cases that read them
const HARNESS = { options: { sentinelPrefix: '/tmp/canon-declared-red-', gatePhrase: 'red before ending the turn' } }
// the d.ts bound on one fs.write
const CAP = 4 * 1024 * 1024
// a stop gate's reason and a subagent gate's advisory, as each might print them
const STOP_RED = 'vitest is red before ending the turn:\n FAIL  src/lib/a.test.ts\none-minute load 3.1, threshold 32'
const LANE_RED = '[subagent-test-gate] A subagent left typescript changed and vitest is red before ending the turn.'

type World = {
  tests: string[]
  output: string
  exitCode: number
  runFails?: boolean
  live: string[]
  listThrows?: boolean
  shellStop?: string
  shellAdvice?: string
  head?: string
  // paths git status reports dirty; absent, every path asked about is dirty
  dirty?: string[]
  // how long one vitest run takes on the engine's clock
  runMs?: number
  clockStart?: number
  // directories that exist beside the test files, a worktree's root among them
  dirs?: string[]
  // where the session runs, $.session.cwd(); absent, the call is refused
  cwd?: string
  // what $.settings.read answers per source; absent, the read is refused as no stub answers it
  settings?: Partial<Record<'project' | 'local', Record<string, unknown>>> | 'refused'
  // what $.fs.list answers per absolute folder; a folder not listed is refused
  listing?: Record<string, Array<{ name: string; kind: 'file' | 'dir' }>>
}
type Seen = {
  runs: string[][]
  cwds: string[]
  heads: string[]
  // the timeoutMs each scoped run was given
  bounds: Array<number | undefined>
  files: Record<string, string>
  shown: Array<string | undefined>
  // the source of each settings read, in order
  reads: string[]
}

const lane = (id: string): AgentInfo => ({ id, status: 'running', type: 'general-purpose', description: `lane ${id}` })

// the engine beneath the mod: tools that write, a vitest that answers, the files, and the shell gates
function engine(on: On, world: World): Seen {
  const seen: Seen = { runs: [], cwds: [], heads: [], bounds: [], files: { '/proc/loadavg': '3.10 2.00 1.00 2/900 1234\n' }, shown: [], reads: [] }
  let clock = world.clockStart ?? 0
  on('session.root', () => ({ value: '/repo' }))
  on('clock.now', () => ({ value: clock }))
  on('agent.list', () => (world.listThrows === true ? { deny: 'agent list unavailable' } : { value: world.live.map(lane) }))
  on('session.cwd', () => (world.cwd === undefined ? { deny: 'no cwd' } : { value: world.cwd }))
  on('fs.exists', (_, e) => ({ value: world.tests.some(t => `/repo/${t}` === e.path) || (world.dirs ?? []).includes(e.path) }))
  on('fs.list', (_, e) => {
    const entries = world.listing?.[e.path]
    return entries === undefined ? { deny: 'ENOENT' } : { value: entries.map(x => ({ ...x, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_, e) => (seen.files[e.path] === undefined ? { deny: 'ENOENT' } : { value: seen.files[e.path] ?? '' }))
  on('fs.write', (_, e) => {
    if (e.text.length > CAP) return { deny: 'a write over 4 MiB rejects' }
    seen.files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git' && e.argv[1] === 'status') {
      const asked = e.argv.slice(e.argv.indexOf('--') + 1)
      const stdout = (world.dirty ?? asked).map(p => ` M ${p}\n`).join('')
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'git') {
      seen.heads.push(e.init?.cwd ?? '')
      const stdout = `${world.head ?? 'aaa111'}\n`
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    seen.runs.push([...e.argv])
    seen.cwds.push(e.init?.cwd ?? '')
    seen.bounds.push(e.init?.timeoutMs)
    clock += world.runMs ?? 0
    if (world.runFails === true) return { deny: 'timed out' }
    return {
      value: { exitCode: world.exitCode, stdout: world.output, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  const planted = world.settings
  if (planted !== undefined)
    on('settings.read', (_, e) => {
      seen.reads.push(e.source ?? 'merged')
      if (planted === 'refused') return { deny: 'settings unreadable' }
      return { value: e.source === 'project' || e.source === 'local' ? (planted[e.source] ?? {}) : {} }
    })
  on('ui.status', (_, e) => {
    seen.shown.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', (_, e) =>
    e.tool === 'Write' && e.file_path.endsWith('denied.ts') ? { deny: 'refused' } : { result: { stdout: '', stderr: '', interrupted: false } },
  )
  on('classic.Stop', () => (world.shellStop === undefined ? {} : { block: world.shellStop }))
  on('classic.SubagentStop', () => (world.shellAdvice === undefined ? {} : { additionalContext: [world.shellAdvice] }))
  return seen
}

const edit = (path: string, agentId?: string) => ({
  tool: 'Edit' as const,
  tool_use_id: 'toolu_test',
  file_path: path,
  old_string: 'a',
  new_string: 'b',
  ...(agentId === undefined ? {} : { agentId }),
})
const write = (path: string, agentId?: string) => ({
  tool: 'Write' as const,
  tool_use_id: 'toolu_test',
  file_path: path,
  content: 'x',
  ...(agentId === undefined ? {} : { agentId }),
})
const read = (path: string) => ({ tool: 'Read' as const, tool_use_id: 'toolu_test', file_path: path })
const notebook = (path: string, agentId?: string) => ({
  tool: 'NotebookEdit' as const,
  tool_use_id: 'toolu_test',
  notebook_path: path,
  new_source: 'x',
  ...(agentId === undefined ? {} : { agentId }),
})
const bash = (command: string, agentId?: string) => ({
  tool: 'Bash' as const,
  tool_use_id: 'toolu_test',
  command,
  ...(agentId === undefined ? {} : { agentId }),
})
const subagentStop = (agentId: string, cwd?: string) => ({
  stop_hook_active: false,
  agent_id: agentId,
  agent_transcript_path: '/t',
  agent_type: 'general-purpose',
  ...(cwd === undefined ? {} : { cwd }),
})
const mainTurn = (agentId?: string): TurnCompleteInput => ({
  answer: 'done',
  durationMs: 1,
  isAborted: false,
  turnId: 'turn_test',
  reason: 'answer',
  ...(agentId === undefined ? {} : { agentId }),
})

const red = (...files: string[]) => files.map(f => ` FAIL  |unit| ${f} > case > fails`).join('\n') + '\n ✓ |unit| src/green.test.ts (2 tests)'
const lines = (seen: Seen) => (seen.files[LOG] ?? '').trim().split('\n')

test('writes are recorded by writer across Edit, Write, NotebookEdit, and Bash, coordinator or lane', async ($, on) => {
  const world: World = {
    tests: ['src/lib/a.test.ts', 'src/lib/b.test.ts', 'src/lib/c.test.ts', 'src/app/(site)/d.test.tsx'],
    output: red('src/lib/a.test.ts', 'src/lib/b.test.ts', 'src/lib/c.test.ts', 'src/app/(site)/d.test.tsx'),
    exitCode: 1,
    live: ['agent_a', 'agent_b'],
  }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/src/lib/a.ts', 'agent_a'))
  await $.tool.call(write('/repo/src/lib/b.test.ts', 'agent_b'))
  await $.tool.call(bash("cat > src/lib/c.ts <<'EOF'\nexport const c = 1\nEOF"))
  await $.tool.call(notebook('/repo/src/app/(site)/d.tsx', 'agent_b'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(lines(seen)[0]).toContain(
    'writers=src/app/(site)/d.tsx:agent_b,src/lib/a.ts:agent_a,src/lib/b.test.ts:agent_b,src/lib/c.ts:coordinator',
  )
  // a, b, and d sit with live lanes; c is the stopping coordinator's own
  expect(lines(seen)[0]).toContain('would=block')
})

test('a denied write and a write outside src are never recorded, and the idle stop logs skip', async ($, on) => {
  const seen = engine(on, { tests: ['src/lib/denied.test.ts'], output: '', exitCode: 0, live: [] })
  await $.tool.call(write('/repo/src/lib/denied.ts', 'agent_a'))
  await $.tool.call(edit('/repo/.claude/skills/suite/hooks/register.ts'))
  await $.tool.call(write('/repo/scripts/tool.ts'))
  await $.tool.call(edit('/repo/e2e/smoke.spec.ts'))
  await $.tool.call(edit('/repo/.claude/worktrees/agent-x/scripts/a.ts', 'agent_x'))
  await $.tool.call(bash('cat > .claude/docs/x.ts'))
  await $.tool.call(edit('/repo/src/lib/notes.md'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs).toEqual([])
  expect(seen.files[LOG]).toBe(
    [
      '1970-01-01T00:00:00.000Z',
      'stop=coordinator',
      'failing=none',
      'declared=none',
      'writers=none',
      'would=skip',
      'shell=pass',
      'load=3.10',
      'run=nothing armed, no recorded write under src in the main tree',
    ].join('\t') + '\n',
  )
})

test('the scoped run takes the tests beside the written paths and nothing else', async ($, on) => {
  const world: World = {
    // e.ts has no test beside it, so it rides the record and never the run
    tests: ['src/lib/a.test.ts', 'src/lib/b.test.ts', 'src/app/[slug]/page.test.tsx'],
    output: '',
    exitCode: 0,
    live: [],
  }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.tool.call(edit('/repo/src/lib/a.test.ts'))
  await $.tool.call(bash('sed -i s/x/y/ src/lib/b.ts && echo done'))
  await $.tool.call(write('/repo/src/app/[slug]/page.tsx', 'agent_a'))
  await $.tool.call(edit('/repo/src/lib/e.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs).toEqual([
    ['./node_modules/.bin/vitest', 'run', 'src/app/[slug]/page.test.tsx', 'src/lib/a.test.ts', 'src/lib/b.test.ts'],
  ])
  expect(lines(seen)[0]).toContain(
    '\trun=vitest run src/app/[slug]/page.test.tsx src/lib/a.test.ts src/lib/b.test.ts exit 0',
  )
})

test('the log line shape is pinned', async ($, on) => {
  const seen = engine(on, { tests: ['src/lib/a.test.ts'], output: red('src/lib/a.test.ts'), exitCode: 1, live: ['agent_a'] })
  await $.tool.call(edit('/repo/src/lib/a.ts', 'agent_a'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.files[LOG]).toBe(
    [
      '1970-01-01T00:00:00.000Z',
      'stop=coordinator',
      'failing=src/lib/a.test.ts',
      'declared=none',
      'writers=src/lib/a.ts:agent_a',
      'would=pass',
      'shell=pass',
      'load=3.10',
      'run=vitest run src/lib/a.test.ts exit 1',
    ].join('\t') + '\n',
  )
})

test('a red in a file nobody wrote maps to nobody and would block', async ($, on) => {
  const seen = engine(on, { tests: ['src/lib/a.test.ts'], output: red('src/lib/z.test.ts'), exitCode: 1, live: ['agent_a'] })
  await $.tool.call(edit('/repo/src/lib/a.ts', 'agent_a'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.files[LOG]).toContain('failing=src/lib/z.test.ts\tdeclared=none\twriters=src/lib/a.ts:agent_a\twould=block')
  expect(seen.shown.at(-1)).toBe('suite shadow: 1 red, nobody')
})

test('the shell column reads pass, suite, and other: with the first five words', HARNESS, async ($, on) => {
  const world: World = { tests: ['src/lib/a.test.ts'], output: red('src/lib/a.test.ts'), exitCode: 1, live: [] }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  world.shellStop = STOP_RED
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  world.shellStop = 'handoff\tnudge:  the\nsession is past seventy percent'
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  const [one, two, three] = lines(seen).map(l => l.split('\t'))
  expect(one?.[6]).toBe('shell=pass')
  expect(two?.[6]).toBe('shell=suite')
  // still nine columns, so a reason's own tab never splits the line
  expect(three).toHaveLength(9)
  expect(three?.[6]).toBe('shell=other:handoff nudge: the session is')
})

test("the subagent gate's advisory reads suite, and a live sibling's red is excused", HARNESS, async ($, on) => {
  const world: World = {
    tests: ['src/lib/a.test.ts', 'src/lib/b.test.ts'],
    output: red('src/lib/b.test.ts'),
    exitCode: 1,
    live: ['agent_a', 'agent_b'],
    shellAdvice: LANE_RED,
  }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/src/lib/a.ts', 'agent_a'))
  await $.tool.call(edit('/repo/src/lib/b.ts', 'agent_b'))
  const stopA = await $.classic.SubagentStop(subagentStop('agent_a'))
  expect(stopA.additionalContext).toEqual([LANE_RED])
  const stopB = await $.classic.SubagentStop(subagentStop('agent_b'))
  expect(stopB.additionalContext).toEqual([LANE_RED])
  const [lineA, lineB] = lines(seen)
  expect(lineA).toContain('stop=agent_a')
  expect(lineA).toContain('would=pass\tshell=suite\t')
  // nothing new between the two stops: the memo spares the run and still names the red's writer
  expect(lineB).toContain('stop=agent_b')
  expect(lineB).toContain('writers=src/lib/a.ts:agent_a,src/lib/b.ts:agent_b')
  expect(lineB).toContain('would=memo')
  expect(seen.runs).toHaveLength(1)
})

test('a fresh sentinel subtracts its files, a stale or malformed one subtracts nothing', HARNESS, async ($, on) => {
  const world: World = {
    tests: ['src/lib/a.test.ts', 'src/lib/b.test.ts'],
    output: red('src/lib/a.test.ts', 'src/lib/b.test.ts'),
    exitCode: 1,
    live: [],
    clockStart: 10_000_000,
  }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.tool.call(edit('/repo/src/lib/b.ts'))
  // born 100 s before the stop, both files declared: the whole red is the round's, so it would pass
  seen.files[SENTINEL] = '9900\nsrc/lib/a.test.ts\nsrc/lib/b.test.ts\n'
  await $.classic.Stop({ stop_hook_active: false })
  expect(lines(seen)[0]).toContain(
    'failing=src/lib/a.test.ts,src/lib/b.test.ts\tdeclared=src/lib/a.test.ts,src/lib/b.test.ts\twriters=src/lib/a.ts:coordinator,src/lib/b.ts:coordinator\twould=pass',
  )
  // one declared: the other is judged alone, the stopper's own
  seen.files[SENTINEL] = '9900\nsrc/lib/a.test.ts\n'
  await $.classic.Stop({ stop_hook_active: false })
  expect(lines(seen)[1]).toContain('declared=src/lib/a.test.ts\twriters=src/lib/a.ts:coordinator,src/lib/b.ts:coordinator\twould=memo')
  // past the 1800 s TTL, and a malformed first line, each declare nothing
  for (const text of ['8000\nsrc/lib/a.test.ts\nsrc/lib/b.test.ts\n', 'soon\nsrc/lib/a.test.ts\nsrc/lib/b.test.ts\n']) {
    seen.files[SENTINEL] = text
    await $.classic.Stop({ stop_hook_active: false })
    expect(lines(seen).at(-1)).toContain('declared=none\twriters=src/lib/a.ts:coordinator,src/lib/b.ts:coordinator')
  }
})

test('nothing ever blocks: the shell answer passes through as it came, a would-block adds none', async ($, on) => {
  const world: World = { tests: ['src/lib/a.test.ts'], output: red('src/lib/a.test.ts'), exitCode: 1, live: [] }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  expect(await $.classic.Stop({ stop_hook_active: false })).toEqual({})
  expect(seen.files[LOG]).toContain('would=block')
  expect(await $.classic.SubagentStop(subagentStop('agent_a'))).toEqual({})
  world.shellStop = STOP_RED
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  expect(await $.classic.Stop({ stop_hook_active: false })).toEqual({ block: STOP_RED })
  // a shadow that throws midway still hands the shell's answer back untouched
  world.listThrows = true
  world.shellAdvice = LANE_RED
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  expect(await $.classic.SubagentStop(subagentStop('agent_a'))).toEqual({ additionalContext: [LANE_RED] })
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  expect(await $.classic.Stop({ stop_hook_active: false })).toEqual({ block: STOP_RED })
  // and a recorded write never changes the call it rode on
  expect(await $.tool.call(write('/repo/src/lib/denied.ts'))).toEqual({ deny: 'refused' })
  expect(await $.tool.call(edit('/repo/src/lib/a.ts'))).toEqual({ result: { stdout: '', stderr: '', interrupted: false } })
})

test('a failed scoped run logs unknown, a run past 60 s logs timeout, and neither sets a memo', async ($, on) => {
  const world: World = { tests: ['src/lib/a.test.ts'], output: '', exitCode: 0, live: [], runFails: true }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  world.runMs = 60_000
  await $.classic.Stop({ stop_hook_active: false })
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs).toHaveLength(3)
  expect(lines(seen)[0]).toContain('would=unknown')
  expect(lines(seen)[1]).toContain('would=timeout')
  expect(lines(seen)[1]).toContain('run=scoped run passed 60 s, vitest run src/lib/a.test.ts')
})

test('the memo keys on paths, writes, and HEAD, and a HEAD change prunes committed paths', async ($, on) => {
  const world: World = { tests: ['src/lib/a.test.ts', 'src/lib/b.test.ts', 'src/lib/c.test.ts'], output: '', exitCode: 0, live: [] }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.tool.call(edit('/repo/src/lib/b.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs).toHaveLength(1)
  expect(lines(seen)[1]).toMatch(/run=memo [0-9a-f]{8}, nothing written or committed since the last judged stop$/)
  // a new write to a recorded path judges again
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs).toHaveLength(2)
  // a write outside src moves nothing
  await $.tool.call(edit('/repo/.claude/docs/x.md'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs).toHaveLength(2)
  // a commit: a.ts is clean and leaves the record for good, b.ts is still dirty
  world.head = 'bbb222'
  world.dirty = ['src/lib/b.ts']
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs[2]).toEqual(['./node_modules/.bin/vitest', 'run', 'src/lib/b.test.ts'])
  world.dirty = undefined
  await $.tool.call(edit('/repo/src/lib/c.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs[3]).toEqual(['./node_modules/.bin/vitest', 'run', 'src/lib/b.test.ts', 'src/lib/c.test.ts'])
})

test('a stop already re-entered runs nothing', async ($, on) => {
  const seen = engine(on, { tests: ['src/lib/a.test.ts'], output: '', exitCode: 0, live: [] })
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.classic.Stop({ stop_hook_active: true })
  expect(seen.runs).toEqual([])
})

test('a log at the write cap rotates to its newest whole lines and the memo still lands', async ($, on) => {
  const seen = engine(on, { tests: ['src/lib/a.test.ts'], output: '', exitCode: 0, live: [] })
  const old = 'old\tline\n'
  seen.files[LOG] = old.repeat(Math.floor((CAP - 10) / old.length))
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs).toHaveLength(1)
  const log = seen.files[LOG] ?? ''
  expect(log.length).toBeLessThanOrEqual(512 * 1024 + 1024)
  expect(log.startsWith(old)).toBe(true)
  expect(lines(seen).at(-2)).toContain('would=pass')
  expect(lines(seen).at(-1)).toContain('would=memo')
})

test('every status write is redrawn at the main-loop turn end and clears on a clean stop', async ($, on) => {
  const world: World = { tests: ['src/lib/a.test.ts'], output: red('src/lib/a.test.ts'), exitCode: 1, live: [] }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/src/lib/a.ts', 'agent_a'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.shown.at(-1)).toBe('suite shadow: 1 red, agent_a')
  const drawn = seen.shown.length
  // a lane's turn end leaves the entry alone, the main loop's redraws it
  await $.turn.complete(mainTurn('agent_a'))
  expect(seen.shown).toHaveLength(drawn)
  await $.turn.complete(mainTurn())
  expect(seen.shown).toHaveLength(drawn + 1)
  expect(seen.shown.at(-1)).toBe('suite shadow: 1 red, agent_a')
  // the fix lands green: the stop clears it and the next turn end keeps it cleared
  world.output = ''
  world.exitCode = 0
  await $.tool.call(edit('/repo/src/lib/a.ts', 'agent_a'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.shown.at(-1)).toBe(undefined)
  await $.turn.complete(mainTurn())
  expect(seen.shown.at(-1)).toBe(undefined)
})

// a worktree lane writes under its own tree, and its stops judge that tree
const TREE = '.claude/worktrees/agent-x'

test('a write under a worktree records against that tree and its SubagentStop judges it there', async ($, on) => {
  const world: World = { tests: [`${TREE}/src/lib/a.test.ts`], output: '', exitCode: 0, live: ['agent_x'], dirs: [`/repo/${TREE}`] }
  const seen = engine(on, world)
  await $.tool.call(edit(`/repo/${TREE}/src/lib/a.ts`, 'agent_x'))
  await $.classic.SubagentStop(subagentStop('agent_x', `/repo/${TREE}`))
  expect(seen.runs).toEqual([['./node_modules/.bin/vitest', 'run', 'src/lib/a.test.ts']])
  expect(seen.cwds).toEqual([`/repo/${TREE}`])
  expect(seen.heads).toEqual([`/repo/${TREE}`])
  expect(lines(seen)[0]).toContain(`stop=agent_x\tfailing=none\tdeclared=none\twriters=src/lib/a.ts:agent_x\twould=pass`)
  expect(lines(seen)[0]).toMatch(new RegExp(`run=vitest run src/lib/a.test.ts exit 0 in ${TREE.replace(/\./g, '\\.')}$`))
})

test("a stop in the main tree never judges a worktree's record, and logs skip", async ($, on) => {
  const world: World = { tests: [`${TREE}/src/lib/a.test.ts`], output: '', exitCode: 0, live: ['agent_x'], dirs: [`/repo/${TREE}`] }
  const seen = engine(on, world)
  await $.tool.call(edit(`/repo/${TREE}/src/lib/a.ts`, 'agent_x'))
  await $.classic.Stop({ stop_hook_active: false, cwd: '/repo' })
  expect(seen.runs).toEqual([])
  expect(lines(seen)[0]).toContain('writers=none\twould=skip')
  expect(lines(seen)[0]).toContain('run=nothing armed, no recorded write under src in the main tree')
  // the worktree's record survives the main tree's stop, its own stop still runs it
  await $.classic.SubagentStop(subagentStop('agent_x', `/repo/${TREE}`))
  expect(seen.runs).toHaveLength(1)
})

test('an idle SubagentStop in a worktree logs skip naming the tree', async ($, on) => {
  const seen = engine(on, { tests: [], output: '', exitCode: 0, live: [] })
  await $.classic.SubagentStop(subagentStop('agent_x', `/repo/${TREE}`))
  expect(lines(seen)[0]).toContain(`stop=agent_x`)
  expect(lines(seen)[0]).toContain(`would=skip`)
  expect(lines(seen)[0]).toContain(`run=nothing armed, no recorded write under src in ${TREE}`)
})

test("a lane's relative Bash targets wait for its SubagentStop and resolve against its cwd", async ($, on) => {
  const world: World = { tests: [`${TREE}/src/lib/b.test.ts`], output: '', exitCode: 0, live: ['agent_x'], dirs: [`/repo/${TREE}`] }
  const seen = engine(on, world)
  await $.tool.call(bash("cat > src/lib/b.ts <<'EOF'\nexport const b = 1\nEOF", 'agent_x'))
  // held, not recorded: the coordinator's stop in the main tree finds nothing armed
  await $.classic.Stop({ stop_hook_active: false, cwd: '/repo' })
  expect(lines(seen)[0]).toContain('would=skip')
  await $.classic.SubagentStop(subagentStop('agent_x', `/repo/${TREE}`))
  expect(seen.runs).toEqual([['./node_modules/.bin/vitest', 'run', 'src/lib/b.test.ts']])
  expect(lines(seen)[1]).toContain('writers=src/lib/b.ts:agent_x')
  // the hold is spent: a second stop finds the record, now memoized, and nothing held again
  await $.classic.SubagentStop(subagentStop('agent_x', `/repo/${TREE}`))
  expect(lines(seen)[2]).toContain('would=memo')
})

test("the main loop's relative Bash target resolves against the session cwd", async ($, on) => {
  const world: World = { tests: [`${TREE}/src/lib/c.test.ts`], output: '', exitCode: 0, live: [], dirs: [`/repo/${TREE}`], cwd: `/repo/${TREE}` }
  const seen = engine(on, world)
  await $.tool.call(bash('touch src/lib/c.ts'))
  // after EnterWorktree the coordinator stops in the worktree its writes went to
  await $.classic.Stop({ stop_hook_active: false, cwd: `/repo/${TREE}` })
  expect(seen.cwds).toEqual([`/repo/${TREE}`])
  expect(lines(seen)[0]).toContain('writers=src/lib/c.ts:coordinator')
})

test('one memo per tree: alternating stops in two trees never evict each other', async ($, on) => {
  const world: World = {
    tests: ['src/lib/a.test.ts', `${TREE}/src/lib/a.test.ts`],
    output: '',
    exitCode: 0,
    live: [],
    dirs: [`/repo/${TREE}`],
  }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.tool.call(edit(`/repo/${TREE}/src/lib/a.ts`, 'agent_x'))
  await $.classic.Stop({ stop_hook_active: false, cwd: '/repo' })
  await $.classic.SubagentStop(subagentStop('agent_x', `/repo/${TREE}`))
  await $.classic.Stop({ stop_hook_active: false, cwd: '/repo' })
  await $.classic.SubagentStop(subagentStop('agent_x', `/repo/${TREE}`))
  expect(seen.runs).toHaveLength(2)
  expect(lines(seen).map(l => /would=(\w+)/.exec(l)?.[1])).toEqual(['pass', 'pass', 'memo', 'memo'])
})

test("a removed worktree's records leave the record", async ($, on) => {
  const world: World = { tests: ['src/lib/a.test.ts'], output: '', exitCode: 0, live: [], dirs: [] }
  const seen = engine(on, world)
  await $.tool.call(edit(`/repo/${TREE}/src/lib/a.ts`, 'agent_x'))
  await $.classic.Stop({ stop_hook_active: false, cwd: '/repo' })
  // the tree is gone, so its stop finds nothing left to judge
  await $.classic.SubagentStop(subagentStop('agent_x', `/repo/${TREE}`))
  expect(seen.runs).toEqual([])
  expect(lines(seen)[1]).toContain('would=skip')
})

test('two lanes stopping together each keep their log line', async ($, on) => {
  const other = '.claude/worktrees/agent-y'
  const world: World = { tests: [], output: '', exitCode: 0, live: [], dirs: [`/repo/${TREE}`, `/repo/${other}`] }
  const seen = engine(on, world)
  await Promise.all([
    $.classic.SubagentStop(subagentStop('agent_x', `/repo/${TREE}`)),
    $.classic.SubagentStop(subagentStop('agent_y', `/repo/${other}`)),
  ])
  expect(lines(seen)).toHaveLength(2)
})

test("a worktree stop reads that tree's sentinel", HARNESS, async ($, on) => {
  const world: World = {
    tests: [`${TREE}/src/lib/a.test.ts`],
    output: red('src/lib/a.test.ts'),
    exitCode: 1,
    live: [],
    dirs: [`/repo/${TREE}`],
    clockStart: 10_000_000,
  }
  const seen = engine(on, world)
  // printf '%s' /repo/.claude/worktrees/agent-x | sha256sum | cut -c1-16
  seen.files[TREE_SENTINEL] = '9900\nsrc/lib/a.test.ts\n'
  await $.tool.call(edit(`/repo/${TREE}/src/lib/a.ts`, 'agent_x'))
  await $.classic.SubagentStop(subagentStop('agent_x', `/repo/${TREE}`))
  expect(lines(seen)[0]).toContain('failing=src/lib/a.test.ts\tdeclared=src/lib/a.test.ts')
})

// one case per userConfig option: the default reading, then a non-default value

test('sourceRoot defaults to src and a set root arms its own folder instead', async ($, on) => {
  const seen = engine(on, { tests: ['src/lib/a.test.ts', 'lib/a.test.ts'], output: '', exitCode: 0, live: [] })
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.tool.call(edit('/repo/lib/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs).toEqual([['./node_modules/.bin/vitest', 'run', 'src/lib/a.test.ts']])
})

test('sourceRoot set to lib records lib and never src', { options: { sourceRoot: 'lib' } }, async ($, on) => {
  const seen = engine(on, { tests: ['src/lib/a.test.ts', 'lib/a.test.ts'], output: red('lib/a.test.ts'), exitCode: 1, live: [] })
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.tool.call(edit('/repo/lib/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs).toEqual([['./node_modules/.bin/vitest', 'run', 'lib/a.test.ts']])
  expect(lines(seen)[0]).toContain('failing=lib/a.test.ts\tdeclared=none\twriters=lib/a.ts:coordinator\twould=block')
})

test('testSuffixes default to .test.ts and .test.tsx, so a .js write is never recorded', async ($, on) => {
  const seen = engine(on, { tests: ['src/a.test.js'], output: '', exitCode: 0, live: [] })
  await $.tool.call(edit('/repo/src/a.js'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(lines(seen)[0]).toContain('would=skip')
})

test('testSuffixes set to .spec.js records a .js source and runs its spec', { options: { testSuffixes: '.spec.js' } }, async ($, on) => {
  const seen = engine(on, { tests: ['src/a.spec.js'], output: red('src/a.spec.js'), exitCode: 1, live: [] })
  await $.tool.call(edit('/repo/src/a.js', 'agent_a'))
  await $.tool.call(edit('/repo/src/b.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs).toEqual([['./node_modules/.bin/vitest', 'run', 'src/a.spec.js']])
  expect(lines(seen)[0]).toContain('failing=src/a.spec.js\tdeclared=none\twriters=src/a.js:agent_a\twould=block')
  expect(seen.shown.at(-1)).toBe('suite shadow: 1 red, agent_a')
})

test('runner defaults to vitest run called direct', async ($, on) => {
  const seen = engine(on, { tests: ['src/a.test.ts'], output: '', exitCode: 0, live: [] })
  await $.tool.call(edit('/repo/src/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs).toEqual([['./node_modules/.bin/vitest', 'run', 'src/a.test.ts']])
  expect(lines(seen)[0]).toContain('run=vitest run src/a.test.ts exit 0')
})

test('runner set to jest runs jest and names it in the log', { options: { runner: 'node_modules/.bin/jest --ci' } }, async ($, on) => {
  const seen = engine(on, { tests: ['src/a.test.ts'], output: '', exitCode: 0, live: [] })
  await $.tool.call(edit('/repo/src/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs).toEqual([['node_modules/.bin/jest', '--ci', 'src/a.test.ts']])
  expect(lines(seen)[0]).toContain('run=jest --ci src/a.test.ts exit 0')
})

test('logPath defaults under the system tmp folder, so an idle stop writes nothing in the repo', async ($, on) => {
  const seen = engine(on, { tests: [], output: '', exitCode: 0, live: [] })
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.files['/tmp/suite-shadow-repo.log']).toContain('would=skip')
  expect(Object.keys(seen.files).filter(p => p.startsWith('/repo/'))).toEqual([])
})

test('logPath set to a repo path writes there', { options: { logPath: '.claude/state/suite-shadow.log' } }, async ($, on) => {
  const seen = engine(on, { tests: [], output: '', exitCode: 0, live: [] })
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.files['/repo/.claude/state/suite-shadow.log']).toContain('would=skip')
  expect(seen.files[LOG]).toBe(undefined)
})

test('logPath set elsewhere writes there and nowhere else', { options: { logPath: 'logs/shadow.tsv' } }, async ($, on) => {
  const seen = engine(on, { tests: [], output: '', exitCode: 0, live: [] })
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.files[LOG]).toBe(undefined)
  expect(seen.files['/repo/logs/shadow.tsv']).toContain('would=skip')
})

test('worktreeDir defaults to .claude/worktrees', async ($, on) => {
  const world: World = { tests: [`${TREE}/src/a.test.ts`], output: '', exitCode: 0, live: [], dirs: [`/repo/${TREE}`] }
  const seen = engine(on, world)
  await $.tool.call(edit(`/repo/${TREE}/src/a.ts`, 'agent_x'))
  await $.classic.SubagentStop(subagentStop('agent_x', `/repo/${TREE}`))
  expect(seen.cwds).toEqual([`/repo/${TREE}`])
})

test('worktreeDir set to wt splits trees there, and the old folder is just a path', { options: { worktreeDir: 'wt' } }, async ($, on) => {
  const world: World = { tests: ['wt/lane/src/a.test.ts'], output: '', exitCode: 0, live: [], dirs: ['/repo/wt/lane'] }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/wt/lane/src/a.ts', 'agent_x'))
  // under the default folder this path is no tree, and its src is not the main tree's src either
  await $.tool.call(edit(`/repo/${TREE}/src/b.ts`, 'agent_y'))
  await $.classic.SubagentStop(subagentStop('agent_x', '/repo/wt/lane'))
  expect(seen.runs).toEqual([['./node_modules/.bin/vitest', 'run', 'src/a.test.ts']])
  expect(seen.cwds).toEqual(['/repo/wt/lane'])
  expect(lines(seen)[0]).toMatch(/run=vitest run src\/a\.test\.ts exit 0 in wt\/lane$/)
})

test('runTimeoutSeconds defaults to 60 and is passed as the run bound', async ($, on) => {
  const world: World = { tests: ['src/a.test.ts'], output: '', exitCode: 0, live: [], runFails: true, runMs: 59_000 }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/src/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.bounds).toEqual([60_000])
  expect(lines(seen)[0]).toContain('would=unknown')
})

test('runTimeoutSeconds set to 5 bounds the run at 5 s', { options: { runTimeoutSeconds: 5 } }, async ($, on) => {
  const world: World = { tests: ['src/a.test.ts'], output: '', exitCode: 0, live: [], runFails: true, runMs: 5_000 }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/src/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.bounds).toEqual([5_000])
  expect(lines(seen)[0]).toContain('would=timeout')
  expect(lines(seen)[0]).toContain('run=scoped run passed 5 s, vitest run src/a.test.ts')
})

test('sentinelPrefix defaults to empty, so no sentinel is read', async ($, on) => {
  const world: World = { tests: ['src/lib/a.test.ts'], output: red('src/lib/a.test.ts'), exitCode: 1, live: [], clockStart: 10_000_000 }
  const seen = engine(on, world)
  seen.files[SENTINEL] = '9900\nsrc/lib/a.test.ts\n'
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(lines(seen)[0]).toContain('declared=none')
})

test('sentinelPrefix set to the old harness path reads its sentinel', HARNESS, async ($, on) => {
  const world: World = { tests: ['src/lib/a.test.ts'], output: red('src/lib/a.test.ts'), exitCode: 1, live: [], clockStart: 10_000_000 }
  const seen = engine(on, world)
  seen.files[SENTINEL] = '9900\nsrc/lib/a.test.ts\n'
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(lines(seen)[0]).toContain('declared=src/lib/a.test.ts')
})

test('sentinelPrefix set reads that path and never the old harness one', { options: { sentinelPrefix: '/var/tmp/red-' } }, async ($, on) => {
  const world: World = { tests: ['src/lib/a.test.ts'], output: red('src/lib/a.test.ts'), exitCode: 1, live: [], clockStart: 10_000_000 }
  const seen = engine(on, world)
  seen.files[SENTINEL] = '9900\nsrc/lib/a.test.ts\n'
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(lines(seen)[0]).toContain('declared=none')
  seen.files['/var/tmp/red-816fc349d3faebf8'] = '9900\nsrc/lib/a.test.ts\n'
  await $.classic.Stop({ stop_hook_active: false })
  expect(lines(seen)[1]).toContain('declared=src/lib/a.test.ts')
})

test('sentinelPrefix empty reads no sentinel at all', { options: { sentinelPrefix: '' } }, async ($, on) => {
  const world: World = { tests: ['src/lib/a.test.ts'], output: red('src/lib/a.test.ts'), exitCode: 1, live: [], clockStart: 10_000_000 }
  const seen = engine(on, world)
  seen.files[SENTINEL] = '9900\nsrc/lib/a.test.ts\n'
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(lines(seen)[0]).toContain('declared=none')
})

test('sentinelTtlSeconds defaults to 1800, so a 1000 s old sentinel still declares', HARNESS, async ($, on) => {
  const world: World = { tests: ['src/lib/a.test.ts'], output: red('src/lib/a.test.ts'), exitCode: 1, live: [], clockStart: 10_000_000 }
  const seen = engine(on, world)
  seen.files[SENTINEL] = '9000\nsrc/lib/a.test.ts\n'
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(lines(seen)[0]).toContain('declared=src/lib/a.test.ts')
})

test('sentinelTtlSeconds set to 600 lets the same sentinel lapse', { options: { ...HARNESS.options, sentinelTtlSeconds: 600 } }, async ($, on) => {
  const world: World = { tests: ['src/lib/a.test.ts'], output: red('src/lib/a.test.ts'), exitCode: 1, live: [], clockStart: 10_000_000 }
  const seen = engine(on, world)
  seen.files[SENTINEL] = '9000\nsrc/lib/a.test.ts\n'
  await $.tool.call(edit('/repo/src/lib/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(lines(seen)[0]).toContain('declared=none')
})

test('gatePhrase defaults to empty, so any block reads gate and silence reads pass', async ($, on) => {
  const world: World = { tests: [], output: '', exitCode: 0, live: [], shellStop: 'tests are red before ending the turn' }
  const seen = engine(on, world)
  await $.classic.Stop({ stop_hook_active: false })
  world.shellStop = 'handoff nudge: the session is past seventy percent'
  await $.classic.Stop({ stop_hook_active: false })
  world.shellStop = undefined
  await $.classic.Stop({ stop_hook_active: false })
  expect(lines(seen)[0]).toContain('shell=gate')
  expect(lines(seen)[1]).toContain('shell=gate')
  expect(lines(seen)[2]).toContain('shell=pass')
})

test('gatePhrase set to its own words reads suite on them and other on the default', { options: { gatePhrase: 'jest failed' } }, async ($, on) => {
  const world: World = { tests: [], output: '', exitCode: 0, live: [], shellStop: 'tests are red before ending the turn' }
  const seen = engine(on, world)
  await $.classic.Stop({ stop_hook_active: false })
  world.shellStop = 'the jest failed on two files'
  await $.classic.Stop({ stop_hook_active: false })
  expect(lines(seen)[0]).toContain('shell=other:tests are red before ending')
  expect(lines(seen)[1]).toContain('shell=suite')
})

// the per-repo options read: the project block, then the local one, over the user options

const block = (options: Record<string, unknown>, key = 'lane-blame@claude-lanes') => ({ pluginConfigs: { [key]: { options } } })

test(
  'a project block field wins over the user value, local over project',
  { options: { sourceRoot: 'lib', runner: 'node_modules/.bin/mocha' } },
  async ($, on) => {
    const world: World = {
      tests: ['app/a.test.ts', 'lib/a.test.ts'],
      output: '',
      exitCode: 0,
      live: [],
      settings: {
        project: {
          pluginConfigs: {
            'lane-fence@claude-lanes': { options: { sourceRoot: 'elsewhere' } },
            'lane-blame@claude-lanes': { options: { sourceRoot: 'app', runner: 'node_modules/.bin/ava', runTimeoutSeconds: 5 } },
          },
        },
        // another marketplace's key still names this mod, and a list takes a JSON array
        local: block({ runner: ['node_modules/.bin/jest', '--ci'] }, 'lane-blame@elsewhere'),
      },
    }
    const seen = engine(on, world)
    // a call that writes nothing never waits on the read
    await $.tool.call(read('/repo/app/a.ts'))
    expect(seen.reads).toEqual([])
    await $.tool.call(edit('/repo/app/a.ts'))
    await $.tool.call(edit('/repo/lib/a.ts'))
    await $.classic.Stop({ stop_hook_active: false })
    await $.classic.Stop({ stop_hook_active: false })
    expect(seen.runs).toEqual([['node_modules/.bin/jest', '--ci', 'app/a.test.ts']])
    expect(seen.bounds).toEqual([5_000])
    // once per session, project then local
    expect(seen.reads).toEqual(['project', 'local'])
  },
)

test('a wrong-typed project field is ignored and the user value stands', { options: { sourceRoot: 'lib' } }, async ($, on) => {
  const world: World = {
    tests: ['lib/a.test.ts', 'app/a.test.ts'],
    output: '',
    exitCode: 0,
    live: [],
    settings: { project: block({ sourceRoot: 5, runTimeoutSeconds: '5', runner: ['jest', 3], gatePhrase: true }) },
  }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/lib/a.ts'))
  await $.tool.call(edit('/repo/app/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs).toEqual([['./node_modules/.bin/vitest', 'run', 'lib/a.test.ts']])
  expect(seen.bounds).toEqual([60_000])
  expect(seen.reads).toEqual(['project', 'local'])
})

test('no project block changes nothing', { options: { sourceRoot: 'lib' } }, async ($, on) => {
  const world: World = {
    tests: ['lib/a.test.ts', 'src/a.test.ts'],
    output: '',
    exitCode: 0,
    live: [],
    settings: { project: { pluginConfigs: { 'lane-pace@claude-lanes': { options: { quietCap: 4 } } } }, local: {} },
  }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/lib/a.ts'))
  await $.tool.call(edit('/repo/src/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs).toEqual([['./node_modules/.bin/vitest', 'run', 'lib/a.test.ts']])
  expect(seen.reads).toEqual(['project', 'local'])
})

test('a settings read that rejects leaves the user options standing', { options: { sourceRoot: 'lib' } }, async ($, on) => {
  const world: World = { tests: ['lib/a.test.ts', 'src/a.test.ts'], output: '', exitCode: 0, live: [], settings: 'refused' }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/lib/a.ts'))
  await $.tool.call(edit('/repo/src/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs).toEqual([['./node_modules/.bin/vitest', 'run', 'lib/a.test.ts']])
  expect(seen.reads).toEqual(['project', 'local'])
})

// several source roots, and a tests folder beside each

const ROOTS = 'lane-pace/hooks lane-fence/hooks'
const file = (name: string) => ({ name, kind: 'file' as const })
const dir = (name: string) => ({ name, kind: 'dir' as const })

test('sourceRoot lists two roots and records under both', { options: { sourceRoot: ROOTS } }, async ($, on) => {
  const world: World = {
    tests: ['lane-pace/hooks/register.test.ts', 'lane-fence/hooks/register.test.ts', 'src/a.test.ts'],
    output: red('lane-fence/hooks/register.test.ts'),
    exitCode: 1,
    live: [],
  }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/lane-pace/hooks/register.ts', 'agent_a'))
  await $.tool.call(edit('/repo/lane-fence/hooks/register.ts', 'agent_b'))
  await $.tool.call(edit('/repo/src/a.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs).toEqual([['./node_modules/.bin/vitest', 'run', 'lane-fence/hooks/register.test.ts', 'lane-pace/hooks/register.test.ts']])
  expect(lines(seen)[0]).toContain(
    'failing=lane-fence/hooks/register.test.ts\tdeclared=none\twriters=lane-fence/hooks/register.ts:agent_b,lane-pace/hooks/register.ts:agent_a\twould=block',
  )
  expect(seen.shown.at(-1)).toBe('suite shadow: 1 red, agent_b')
})

test(
  "testFolder set runs the folder's tests on a write under the root and a red names every writer under it",
  { options: { sourceRoot: ROOTS, testFolder: 'tests', runner: 'claude plugin test' } },
  async ($, on) => {
    const world: World = {
      tests: [],
      output: red('lane-pace/tests/pace.test.ts'),
      exitCode: 1,
      live: [],
      listing: {
        '/repo/lane-pace/tests': [file('pace.test.ts'), dir('fixtures'), file('notes.md')],
        '/repo/lane-pace/tests/fixtures': [file('deep.test.ts')],
        '/repo/lane-fence/tests': [file('fence.test.ts')],
      },
    }
    const seen = engine(on, world)
    await $.tool.call(edit('/repo/lane-pace/hooks/register.ts', 'agent_a'))
    await $.tool.call(edit('/repo/lane-pace/hooks/util.ts', 'agent_b'))
    await $.tool.call(edit('/repo/lane-fence/hooks/register.ts', 'agent_c'))
    await $.classic.Stop({ stop_hook_active: false })
    expect(seen.runs).toEqual([
      ['claude', 'plugin', 'test', 'lane-fence/tests/fence.test.ts', 'lane-pace/tests/fixtures/deep.test.ts', 'lane-pace/tests/pace.test.ts'],
    ])
    // the named red sits under lane-pace, so every writer under lane-pace/hooks owns it and none under lane-fence
    expect(lines(seen)[0]).toContain('failing=lane-pace/tests/pace.test.ts\tdeclared=none')
    expect(seen.shown.at(-1)).toBe('suite shadow: 1 red, agent_a, agent_b')
    // a red whose output names no file, as claude plugin test prints it: every test that ran is red
    world.output = 'claude plugin test: 1 fail'
    await $.tool.call(edit('/repo/lane-fence/hooks/register.ts', 'agent_c'))
    await $.classic.Stop({ stop_hook_active: false })
    expect(lines(seen)[1]).toContain(
      'failing=lane-fence/tests/fence.test.ts,lane-pace/tests/fixtures/deep.test.ts,lane-pace/tests/pace.test.ts\tdeclared=none',
    )
    expect(lines(seen)[1]).toContain('would=block')
    expect(seen.shown.at(-1)).toBe('suite shadow: 3 red, agent_c, agent_a, agent_b')
  },
)

test('testFolder empty keeps the sibling rule', { options: { sourceRoot: 'lane-pace/hooks', testFolder: '' } }, async ($, on) => {
  const world: World = {
    tests: ['lane-pace/hooks/register.test.ts', 'lane-pace/tests/pace.test.ts'],
    output: '',
    exitCode: 0,
    live: [],
    listing: { '/repo/lane-pace/tests': [file('pace.test.ts')] },
  }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/lane-pace/hooks/register.ts'))
  await $.tool.call(edit('/repo/lane-pace/tests/pace.test.ts'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.runs).toEqual([['./node_modules/.bin/vitest', 'run', 'lane-pace/hooks/register.test.ts']])
  expect(lines(seen)[0]).toContain('writers=lane-pace/hooks/register.ts:coordinator\twould=pass')
})

test(
  'a write under the tests folder is recorded and runs itself',
  { options: { sourceRoot: 'lane-pace/hooks', testFolder: 'tests' } },
  async ($, on) => {
    const world: World = {
      tests: ['lane-pace/tests/pace.test.ts', 'lane-pace/tests/other.test.ts'],
      output: '',
      exitCode: 0,
      live: [],
      listing: { '/repo/lane-pace/tests': [file('pace.test.ts'), file('other.test.ts')] },
    }
    const seen = engine(on, world)
    await $.tool.call(edit('/repo/lane-pace/tests/pace.test.ts', 'agent_a'))
    await $.classic.Stop({ stop_hook_active: false })
    expect(seen.runs).toEqual([['./node_modules/.bin/vitest', 'run', 'lane-pace/tests/pace.test.ts']])
    expect(lines(seen)[0]).toContain('writers=lane-pace/tests/pace.test.ts:agent_a\twould=pass')
  },
)

test(
  "a helper under the tests folder runs every test in it, in the lane's own tree",
  { options: { sourceRoot: 'lane-pace/hooks', testFolder: 'tests' } },
  async ($, on) => {
    const world: World = {
      tests: [],
      output: '',
      exitCode: 0,
      live: [],
      dirs: [`/repo/${TREE}`],
      listing: { [`/repo/${TREE}/lane-pace/tests`]: [file('pace.test.ts'), file('helpers.ts')] },
    }
    const seen = engine(on, world)
    await $.tool.call(edit(`/repo/${TREE}/lane-pace/tests/helpers.ts`, 'agent_x'))
    await $.classic.SubagentStop(subagentStop('agent_x', `/repo/${TREE}`))
    expect(seen.runs).toEqual([['./node_modules/.bin/vitest', 'run', 'lane-pace/tests/pace.test.ts']])
    expect(seen.cwds).toEqual([`/repo/${TREE}`])
  },
)

test('a stop whose recorded paths were all committed clean clears the red status', async ($, on) => {
  const world: World = { tests: ['src/lib/a.test.ts'], output: red('src/lib/a.test.ts'), exitCode: 1, live: [] }
  const seen = engine(on, world)
  await $.tool.call(edit('/repo/src/lib/a.ts', 'agent_a'))
  await $.classic.Stop({ stop_hook_active: false })
  expect(seen.shown.at(-1)).toBe('suite shadow: 1 red, agent_a')
  // the fix is committed: HEAD moves and the status reports every recorded path clean
  world.head = 'bbb222'
  world.dirty = []
  await $.classic.Stop({ stop_hook_active: false })
  expect(lines(seen)[1]).toContain('would=skip')
  await $.turn.complete(mainTurn())
  expect(seen.shown.at(-1)).toBe(undefined)
})
