import { update } from 'claude-code'
import type { AgentInfo, EngineInterface, PluginOptions, ProcessRunResult, Register } from 'claude-code'
import type { Last, Memo, Writes } from '../types'

// a shadow of the shell test gates: records who wrote what under the source root and logs the
// verdict it WOULD give beside the one the shell gave, so a red names its writer. never blocks

const COORDINATOR = 'coordinator'
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
// fs.write rejects past 4 MiB; past 1 MiB the log keeps its newest 512 KiB of whole lines
const LOG_ROTATE_AT = 1024 * 1024
const LOG_KEEP = 512 * 1024
const LIVE: ReadonlyArray<AgentInfo['status']> = ['pending', 'running', 'waiting']
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

type Verdict = 'block' | 'pass' | 'unknown' | 'timeout' | 'memo' | 'skip'
type Shell = 'pass' | 'suite' | 'gate' | `other:${string}`

// every repo-specific value, built once per load from userConfig and this repo's own block
type Cfg = {
  root: string
  // the root plus its slash, '' when the root is empty
  prefix: string
  suffixes: string[]
  // the source extensions the suffixes imply, .test.ts gives .ts
  exts: string[]
  runner: string[]
  label: string
  log: string
  worktrees: string
  timeoutMs: number
  sentinel: string
  ttlS: number
  phrase: string
  testFile: RegExp
  worktree: RegExp
  moved: RegExp
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d)
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)
// a list option is a space string, or a JSON array where a settings file holds one
const words = (v: unknown, d: string) =>
  (Array.isArray(v) ? v.map(String) : [typeof v === 'string' ? v : d]).flatMap(s => s.split(/\s+/)).filter(w => w.length > 0)
const trimSlashes = (s: string) => s.trim().replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')

const DEFAULT_LOG = '/tmp/suite-shadow.log'
const logOf = (raw: string) => {
  const t = raw.trim()
  if (t.startsWith('/')) return t.replace(/\/+$/, '')
  return trimSlashes(t) || DEFAULT_LOG
}

// Builds the config from the options, each one falling back to the default this mod
// shipped with when it is missing, the wrong type, or empty where empty means nothing.
const cfgOf = (options: PluginOptions | undefined): Cfg => {
  const o = options ?? {}
  const root = trimSlashes(str(o.sourceRoot, 'src'))
  const prefix = root === '' ? '' : `${root}/`
  const listed = words(o.testSuffixes, '.test.ts .test.tsx')
  const suffixes = listed.length > 0 ? listed : ['.test.ts', '.test.tsx']
  const exts = [...new Set(suffixes.map(s => /\.[^.]+$/.exec(s)?.[0] ?? s))]
  const argv = words(o.runner, './node_modules/.bin/vitest run')
  const runner = argv.length > 0 ? argv : ['./node_modules/.bin/vitest', 'run']
  const label = [runner[0]?.split('/').pop() ?? '', ...runner.slice(1)].join(' ')
  const worktrees = trimSlashes(str(o.worktreeDir, '.claude/worktrees')) || '.claude/worktrees'
  const alt = suffixes.map(esc).join('|')
  return {
    root,
    prefix,
    suffixes,
    exts,
    runner,
    label,
    // absolute lands as written, relative joins the main tree's root; the default stays out of the repo
    log: logOf(str(o.logPath, DEFAULT_LOG)),
    worktrees,
    timeoutMs: num(o.runTimeoutSeconds, 60) * 1000,
    sentinel: str(o.sentinelPrefix, '').trim(),
    ttlS: num(o.sentinelTtlSeconds, 1800),
    phrase: str(o.gatePhrase, '').trim(),
    // one class wide enough that a (site) group or a [slug] route is named whole
    testFile: new RegExp(`${esc(prefix)}[\\][A-Za-z0-9_.@()/-]+?(?:${alt})(?![A-Za-z0-9_.@()/-])`, 'g'),
    worktree: new RegExp(`^(${esc(worktrees)}/[^/]+)(?:/|$)`),
    moved: new RegExp(`/${esc(worktrees)}/[^/]+/?$`),
  }
}

const MOD = 'lane-blame'
// the manifest's declared type per option; a list option takes a JSON array of strings as well
const DECLARED = new Map<string, 'string' | 'number' | 'list'>([
  ['sourceRoot', 'list'],
  ['testSuffixes', 'list'],
  ['runner', 'list'],
  ['logPath', 'string'],
  ['worktreeDir', 'string'],
  ['runTimeoutSeconds', 'number'],
  ['sentinelPrefix', 'string'],
  ['sentinelTtlSeconds', 'number'],
  ['gatePhrase', 'string'],
])
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const fits = (kind: 'string' | 'number' | 'list' | undefined, v: unknown) =>
  kind === 'number'
    ? typeof v === 'number'
    : kind !== undefined && (typeof v === 'string' || (kind === 'list' && Array.isArray(v) && v.every(w => typeof w === 'string')))

// Takes this mod's options from one settings source: the first pluginConfigs key, in file order,
// whose name before the @ is this mod, lane-blame@claude-lanes among them. A field the manifest
// does not declare, or one of the wrong type, is dropped, the engine's own counts-as-unset rule.
const blockOf = (settings: unknown): Record<string, string | number | readonly string[]> => {
  const configs = isRecord(settings) ? settings.pluginConfigs : undefined
  if (!isRecord(configs)) return {}
  const entry = Object.entries(configs).find(([key]) => key.split('@')[0] === MOD)?.[1]
  const options = isRecord(entry) ? entry.options : undefined
  if (!isRecord(options)) return {}
  return Object.fromEntries(
    Object.entries(options).filter((kv): kv is [string, string | number | string[]] => fits(DECLARED.get(kv[0]), kv[1])),
  )
}

// the engine hands register the user block alone, so the project and local blocks are read here;
// a source that will not read overrides nothing
async function overridesOf($: EngineInterface) {
  const project = await $.settings.read({ source: 'project' }).catch(() => ({}))
  const local = await $.settings.read({ source: 'local' }).catch(() => ({}))
  return { ...blockOf(project), ...blockOf(local) }
}

// one read per load, filled at the first event that needs config: tool.call fires on every call of
// every agent, so the memo is what keeps it cheap. register clears it, a reload starts over
let loaded: Promise<Cfg> | undefined
const configOf = ($: EngineInterface, options: PluginOptions | undefined) =>
  (loaded ??= overridesOf($).then(
    over => cfgOf({ ...options, ...over }),
    () => cfgOf(options),
  ))

// fnv-1a, 32 bit: the memo needs equality, not secrecy
const hashOf = (text: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

// the sentinel keys on sha256 of the tree path, first 16 hex, so a shell gate can compute it too
const treeHash = async (root: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(root))
  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

const relativeTo = (root: string, path: string) => {
  const bare = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
  return bare.replace(/^\.\//, '')
}
const hasExt = (cfg: Cfg, path: string) => cfg.exts.some(x => path.endsWith(x))
const armed = (cfg: Cfg, inner: string) => inner.startsWith(cfg.prefix) && !inner.startsWith('/') && hasExt(cfg, inner)

// Splits a session-root-relative path into the tree it lives in and its path inside that tree:
// '<worktrees>/agent-x/src/a.ts' is src/a.ts in that worktree, 'src/a.ts' is the main tree's,
// named ''. The record keeps the joined form, so two trees never share a key.
const splitTree = (cfg: Cfg, rel: string) => {
  const tree = cfg.worktree.exec(rel)?.[1]
  return tree === undefined ? { tree: '', inner: rel } : { tree, inner: rel.slice(tree.length + 1) }
}
const joinTree = (tree: string, inner: string) => (tree === '' ? inner : `${tree}/${inner}`)

// session.root follows a worktree move, so every key hangs off the main tree the move left
const mainOf = (cfg: Cfg, root: string) => root.replace(cfg.moved, '')
// the tree a stop's cwd sits in; the root, a cwd outside the repo, or none all read as the main tree
const treeOf = (cfg: Cfg, base: string, cwd: unknown) =>
  typeof cwd === 'string' ? splitTree(cfg, relativeTo(base, cwd)).tree : ''
const resolve = (cwd: string, rel: string) => `${cwd.replace(/\/$/, '')}/${rel.replace(/^\.\//, '')}`

// best effort over the shell's writing verbs; a miss only leaves a write unattributed
const bashTargets = (command: string) => {
  const out: string[] = []
  for (const stmt of command.split(/&&|\|\||[;\n|]/)) {
    const ws = stmt.match(/"[^"]*"|'[^']*'|\S+/g)?.map(w => w.replace(/^(["'])([\s\S]*)\1$/, '$2')) ?? []
    ws.forEach((word, i) => {
      const glued = /^\d?>>?(.+)$/.exec(word)
      if (glued?.[1] !== undefined) out.push(glued[1])
      else if (/^\d?>>?$/.test(word) && ws[i + 1] !== undefined) out.push(ws[i + 1] ?? '')
    })
    const verb = (ws[0] ?? '').split('/').pop() ?? ''
    const args = ws.slice(1).filter(w => !w.startsWith('-'))
    if (verb === 'tee' || verb === 'touch' || verb === 'rm') out.push(...args)
    else if ((verb === 'sed' || verb === 'perl') && ws.some(w => /^-[a-zA-Z]*i/.test(w))) out.push(...args)
    else if ((verb === 'cp' || verb === 'mv' || verb === 'install') && args.length > 1) out.push(args.at(-1) ?? '')
  }
  return out
}

// the paths one tool call writes, as the tool was given them; it needs no config, so a call that
// writes nothing returns before the settings read
const writtenPaths = (input: unknown): string[] => {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const tool = String(args.tool)
  if (FILE_TOOLS.has(tool)) {
    const path = args.file_path ?? args.notebook_path
    return typeof path === 'string' ? [path] : []
  }
  return tool === 'Bash' && typeof args.command === 'string' ? bashTargets(args.command) : []
}

const withWriter = (writes: Writes | undefined, paths: string[], who: string): Writes => {
  const next: Writes = { ...(writes ?? {}) }
  for (const path of paths) {
    const had = next[path] ?? []
    next[path] = had.includes(who) ? had : [...had, who]
  }
  return next
}

const suffixOf = (cfg: Cfg, path: string) => cfg.suffixes.find(s => path.endsWith(s))

// a written test is its own, a source owns every sibling test its extension allows
const testsOf = (cfg: Cfg, path: string): string[] => {
  if (suffixOf(cfg, path) !== undefined) return [path]
  const ext = cfg.exts.find(x => path.endsWith(x))
  if (ext === undefined) return []
  const stem = path.slice(0, -ext.length)
  return cfg.suffixes.filter(s => s.endsWith(ext)).map(s => `${stem}${s}`)
}

// a failing test belongs to whoever wrote it or the source beside it
const writersOf = (cfg: Cfg, failing: string, writes: Writes) => {
  const suffix = suffixOf(cfg, failing)
  const ext = suffix === undefined ? '' : (/\.[^.]+$/.exec(suffix)?.[0] ?? '')
  const source = suffix === undefined ? failing : `${failing.slice(0, -suffix.length)}${ext}`
  return [...new Set([...(writes[failing] ?? []), ...(writes[source] ?? [])])]
}

// the runner's FAIL lines only; a passing file named elsewhere in the output is never a red
const failingFiles = (cfg: Cfg, output: string) => {
  const files = new Set<string>()
  for (const line of output.replace(ANSI, '').split('\n')) {
    if (!/\bFAIL\b/.test(line)) continue
    for (const m of line.match(cfg.testFile) ?? []) files.add(m)
  }
  return [...files].sort()
}

// a numeric epoch first line younger than the TTL, then one tree-relative path a line.
// missing, stale, or malformed declares nothing
const declaredOf = (cfg: Cfg, text: string | undefined, nowMs: number): Set<string> => {
  if (text === undefined) return new Set()
  const [born, ...rest] = text.split('\n')
  if (born === undefined || !/^[0-9]+$/.test(born)) return new Set()
  if (Math.floor(nowMs / 1000) - Number(born) >= cfg.ttlS) return new Set()
  return new Set(rest.map(l => l.trim()).filter(l => l.length > 0))
}

// a red is excused only when some OTHER writer is still live; nobody's red, or the stopper's, blocks
const verdictOf = (cfg: Cfg, reds: string[], writes: Writes, stopper: string, live: Set<string>, ranRed: boolean): Verdict => {
  if (ranRed && reds.length === 0) return 'block'
  return reds.some(f => !writersOf(cfg, f, writes).some(w => w !== stopper && live.has(w))) ? 'block' : 'pass'
}

// Names the hook behind a stop's block or advisory: pass when nothing spoke, gate for any block
// when no phrase is set, suite when the gate phrase is in it, otherwise other: plus the reason's first five words, whitespace folded
// so a tab or newline in the reason cannot split the log line.
const shellOf = (cfg: Cfg, reason: string | undefined): Shell => {
  const ws = words(reason ?? '', '')
  if (ws.length === 0) return 'pass'
  // no phrase set, so any block is the gate's
  if (cfg.phrase === '') return 'gate'
  if (ws.join(' ').includes(cfg.phrase)) return 'suite'
  return `other:${ws.slice(0, 5).join(' ')}`
}

const field = (items: string[]) => (items.length === 0 ? 'none' : items.join(','))

type Judged = {
  at: number
  who: string
  failing: string[]
  declared: string[]
  writes: Writes
  would: Verdict
  shell: Shell
  load: string
  run: string
}

const logLine = (t: Judged) =>
  [
    new Date(t.at).toISOString(),
    `stop=${t.who}`,
    `failing=${field(t.failing)}`,
    `declared=${field(t.declared)}`,
    // the record itself, so a row with nothing failing still shows what was armed
    `writers=${field(Object.keys(t.writes).sort().map(p => `${p}:${(t.writes[p] ?? []).join('+')}`))}`,
    `would=${t.would}`,
    `shell=${t.shell}`,
    `load=${t.load}`,
    `run=${t.run}`,
  ].join('\t')

// the owners a status entry names: every writer of an undeclared red, nobody when none wrote it
const ownersOf = (cfg: Cfg, reds: string[], writes: Writes) => [
  ...new Set(reds.flatMap(f => (writersOf(cfg, f, writes).length > 0 ? writersOf(cfg, f, writes) : ['nobody']))),
]
const statusOf = (last: Last | undefined) =>
  last === undefined || last.reds === 0 ? undefined : `suite shadow: ${last.reds} red, ${last.owners.join(', ')}`

type Io = {
  cfg: Cfg
  root: string
  now: () => Promise<number>
  live: () => Promise<Set<string>>
  exists: (path: string) => Promise<boolean>
  run: (argv: string[], cwd: string) => Promise<ProcessRunResult>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  seq: () => Promise<number>
  // one memo per tree, so alternating stops in two trees never evict each other's
  memo: (tree: string) => Promise<Memo | undefined>
  setMemo: (tree: string, memo: Memo) => Promise<void>
  drop: (paths: string[]) => Promise<void>
}

const treeRoot = (io: Io, tree: string) => (tree === '' ? io.root : `${io.root}/${tree}`)

// the stopping tree's slice of the record, keyed by the path inside that tree
const writesIn = (cfg: Cfg, all: Writes, tree: string): Writes => {
  const out: Writes = {}
  for (const [path, who] of Object.entries(all)) {
    const at = splitTree(cfg, path)
    if (at.tree === tree) out[at.inner] = who
  }
  return out
}

// a removed worktree can never stop again, so its records leave rather than grow the state
async function dropGone(io: Io, all: Writes, tree: string) {
  const others = new Set(Object.keys(all).map(p => splitTree(io.cfg, p).tree).filter(t => t !== '' && t !== tree))
  for (const t of others) {
    if (await io.exists(`${io.root}/${t}`).catch(() => true)) continue
    await io.drop(Object.keys(all).filter(p => splitTree(io.cfg, p).tree === t))
  }
}

// porcelain v1 paths, the rename's new side; a quoted path stays quoted and so stays recorded
const porcelainPaths = (stdout: string) =>
  new Set(
    stdout
      .split('\n')
      .filter(line => line.length > 3)
      .map(line => line.slice(3).split(' -> ').pop() ?? ''),
  )

// after a commit, a recorded path the tree reports clean was committed and leaves the record;
// a failed status keeps everything, a stale record only costs a longer run
async function prune(io: Io, tree: string, paths: string[]): Promise<string[]> {
  const status = await io
    .run(['git', 'status', '--porcelain', '--untracked-files=all', '--', ...paths], treeRoot(io, tree))
    .catch(() => undefined)
  if (status === undefined || status.exitCode !== 0) return paths
  const dirty = porcelainPaths(status.stdout)
  const clean = paths.filter(p => !dirty.has(p))
  if (clean.length > 0) await io.drop(clean.map(p => joinTree(tree, p)))
  return paths.filter(p => dirty.has(p))
}

// the one-minute load, since a red under load is the case the log most needs to show
const loadOf = (io: Io) =>
  io.read('/proc/loadavg').then(
    text => /^[0-9.]+/.exec(text)?.[0] ?? 'unknown',
    () => 'unknown',
  )

// the sentinel for the stopping tree, <prefix><hash of that tree's path>; no prefix, none read
const sentinelOf = async (io: Io, tree: string) => {
  if (io.cfg.sentinel === '') return new Set<string>()
  const path = `${io.cfg.sentinel}${await treeHash(treeRoot(io, tree))}`
  return declaredOf(io.cfg, await io.read(path).catch(() => undefined), await io.now())
}

// One stop's shadow judgment over the stopping tree: scoped run, sentinel, map, log, status. A
// lane in a worktree is judged in its worktree, the main loop and a shared-tree lane in the main
// tree. Never answers for the gate, and every stop writes one line, an idle one would=skip, so a
// loaded mod is told from an unloaded one. Undefined leaves the status entry as it was.
async function shadow(io: Io, who: string, all: Writes, shell: Shell, tree: string): Promise<Last | undefined> {
  const cfg = io.cfg
  await dropGone(io, all, tree)
  const mine = writesIn(cfg, all, tree)
  let paths = Object.keys(mine).sort()
  const where = tree === '' ? 'the main tree' : tree
  const under = cfg.root === '' ? 'the tree' : cfg.root
  // a worktree stop names its tree at the end of run=, so the column count stays pinned
  const inTree = tree === '' ? '' : ` in ${tree}`
  const load = await loadOf(io)
  const skip = async () => {
    const run = `nothing armed, no recorded write under ${under} in ${where}`
    const at = await io.now()
    await appendLine(io, logLine({ at, who, failing: [], declared: [], writes: {}, would: 'skip', shell, load, run }))
    return undefined
  }
  if (paths.length === 0) return skip()
  // a commit moves HEAD and a new write moves seq, either one judges again
  const head = await io.run(['git', 'rev-parse', 'HEAD'], treeRoot(io, tree)).then(
    r => (r.exitCode === 0 ? r.stdout.trim() : 'nohead'),
    () => 'nohead',
  )
  const held = await io.memo(tree)
  if (held?.head !== undefined && held.head !== head) paths = await prune(io, tree, paths)
  if (paths.length === 0) return skip()
  const writes: Writes = Object.fromEntries(paths.map(p => [p, mine[p] ?? []]))
  const declared = await sentinelOf(io, tree)
  const memoKey = hashOf(`${paths.map(p => joinTree(tree, p)).join('\n')}\n${await io.seq()}\n${head}`)
  if (held?.key === memoKey) {
    // the sentinel is read again, it may have expired or grown since the run it repeats
    const reds = held.failing.filter(f => !declared.has(f))
    const run = `memo ${memoKey}, nothing written or committed since the last judged stop${inTree}`
    const at = await io.now()
    const failing = held.failing
    await appendLine(io, logLine({ at, who, failing, declared: failing.filter(f => declared.has(f)), writes, would: 'memo', shell, load, run }))
    return { reds: reds.length, owners: ownersOf(cfg, reds, writes) }
  }
  const tests: string[] = []
  for (const t of [...new Set(paths.flatMap(p => testsOf(cfg, p)))].sort()) if (await io.exists(`${treeRoot(io, tree)}/${t}`)) tests.push(t)
  let failing: string[] = []
  let would: Verdict = 'pass'
  let ranRed = false
  let run: string
  if (tests.length === 0) {
    run = `writers only, no test file under ${under} beside the ${paths.length} recorded write(s)`
  } else {
    // the runner, scoped to the recorded tests in the stopping tree; never the whole suite
    const started = await io.now()
    const ran = await io.run([...cfg.runner, ...tests], treeRoot(io, tree)).catch((err: unknown) => String(err))
    if (typeof ran === 'string' && (await io.now()) - started >= cfg.timeoutMs) {
      // process.run rejects a command still running at its bound, judged by the clock not the text
      would = 'timeout'
      run = `scoped run passed ${cfg.timeoutMs / 1000} s, ${cfg.label} ${tests.join(' ')}`
    } else if (typeof ran === 'string') {
      would = 'unknown'
      run = `scoped run failed: ${ran.replace(/\s+/g, ' ').slice(0, 120)}`
    } else {
      ranRed = ran.exitCode !== 0
      failing = ranRed ? failingFiles(cfg, `${ran.stdout}\n${ran.stderr}`) : []
      run = `${cfg.label} ${tests.join(' ')} exit ${ran.exitCode}`
    }
  }
  const reds = failing.filter(f => !declared.has(f))
  if (would === 'pass') would = verdictOf(cfg, reds, writes, who, await io.live(), ranRed && failing.length === 0)
  const line = { at: await io.now(), who, failing, declared: failing.filter(f => declared.has(f)), writes, would, shell, load, run: `${run}${inTree}` }
  await appendLine(io, logLine(line))
  // a failed or timed-out run judged nothing, so the next stop tries again
  if (would !== 'unknown' && would !== 'timeout') await io.setMemo(tree, { key: memoKey, failing, head })
  return { reds: reds.length, owners: ownersOf(cfg, reds, writes) }
}

// no append in $.fs, so every append reads and rewrites; one module queue runs them in turn, or
// two lanes stopping together both read the same log and the second write drops the first line
let logQueue: Promise<unknown> = Promise.resolve()
function appendLine(io: Io, line: string): Promise<void> {
  const done = logQueue.then(() => rewriteLog(io, line))
  logQueue = done.catch(() => undefined)
  return done
}

// an unreadable log starts over, a long one rotates first
async function rewriteLog(io: Io, line: string) {
  // the shipped default is one file per repo under tmp, keyed by the root folder's name
  const log = io.cfg.log === DEFAULT_LOG ? `/tmp/suite-shadow-${io.root.split('/').filter(Boolean).pop() ?? 'repo'}.log` : io.cfg.log
  const path = log.startsWith('/') ? log : `${io.root}/${log}`
  let before = await io.read(path).catch(() => '')
  if (before.length + line.length + 1 > LOG_ROTATE_AT) {
    const tail = before.slice(-LOG_KEEP)
    const cut = tail.indexOf('\n')
    before = cut === -1 ? '' : tail.slice(cut + 1)
  }
  await io.write(path, `${before}${line}\n`)
}

const WRITES = { plugin: 'lane-blame', key: 'writes' } as const
const SEQ = { plugin: 'lane-blame', key: 'seq' } as const
const LAST = { plugin: 'lane-blame', key: 'last' } as const

// the engine's side of the io, built per stop. the engine only follows $ into a top-level function
async function ioOf($: EngineInterface, cfg: Cfg, base: string): Promise<Io> {
  return {
    cfg,
    root: base,
    now: () => $.clock.now(),
    live: async () => new Set((await $.agent.list()).filter(a => LIVE.includes(a.status)).map(a => a.id)),
    exists: path => $.fs.exists(path),
    run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: cfg.timeoutMs }),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    seq: async () => (await $.state.get(SEQ)).value ?? 0,
    memo: async tree => (await $.state.get({ plugin: 'lane-blame', key: 'memo', id: `memo:${tree}` })).value,
    setMemo: async (tree, held) => {
      await $.state.set({ plugin: 'lane-blame', key: 'memo', id: `memo:${tree}` }, held)
    },
    drop: async paths => {
      await update($, WRITES, w => Object.fromEntries(Object.entries(w ?? {}).filter(([p]) => !paths.includes(p))))
    },
  }
}

// the shadow's half of a stop: judge, keep the result for the redraw, draw it. any throw is eaten
async function judge($: EngineInterface, cfg: Cfg, base: string, who: string, reason: string | undefined, tree: string) {
  try {
    const { value = {} } = await $.state.get(WRITES)
    const judged = await shadow(await ioOf($, cfg, base), who, value, shellOf(cfg, reason), tree)
    if (judged === undefined) return
    await $.state.set(LAST, judged)
    $.ui.status(statusOf(judged))
  } catch {
    // shadow work that fails leaves the gate's answer exactly as it was
  }
}

// only what the suite collects, anything else can never be a suite red; a worktree write is
// tested by its path inside that worktree and keyed with the tree, so it records too
async function record($: EngineInterface, cfg: Cfg, base: string, absolute: string[], who: string) {
  const paths = absolute.map(p => relativeTo(base, p)).filter(p => armed(cfg, splitTree(cfg, p).inner))
  if (paths.length === 0) return
  await update($, WRITES, w => withWriter(w, paths, who))
  await update($, SEQ, n => (n ?? 0) + 1)
}

export const register: Register = (on, options) => {
  loaded = undefined

  // record after the tool answers, so a denied write is never attributed; the result goes back
  // untouched, so the record can never change what the call did
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined) return result
    const given = writtenPaths(e)
    if (given.length === 0) return result
    const cfg = await configOf($, options)
    const raw = given.filter(p => hasExt(cfg, p))
    if (raw.length === 0) return result
    const base = mainOf(cfg, await $.session.root())
    const who = e.agentId ?? COORDINATOR
    const relative = raw.filter(p => !p.startsWith('/'))
    // tool.call carries no cwd, and a lane's shell runs in its own tree: its relative targets
    // wait under its id for the SubagentStop that names that cwd, never keyed to the main tree
    if (e.tool === 'Bash' && e.agentId !== undefined && relative.length > 0) {
      await update($, { plugin: 'lane-blame', key: 'held', id: e.agentId }, h => [...new Set([...(h ?? []), ...relative])])
      await record($, cfg, base, raw.filter(p => p.startsWith('/')), who)
      return result
    }
    // the main loop's own shell resolves against where the session runs now
    const here = relative.length === 0 ? base : await $.session.cwd().catch(() => base)
    await record($, cfg, base, raw.map(p => (p.startsWith('/') ? p : resolve(here, p))), who)
    return result
  }).catch(($, e, next) => next(e))

  // the shell answers first, and its answer is returned as it came, whatever the shadow thinks
  on('classic.Stop', async ($, e, next) => {
    const shell = await next(e)
    if (e.stop_hook_active) return shell
    try {
      const cfg = await configOf($, options)
      const base = mainOf(cfg, await $.session.root())
      // after EnterWorktree the coordinator stops in the worktree its writes went to
      await judge($, cfg, base, COORDINATOR, shell.block, treeOf(cfg, base, e.cwd))
    } catch {
      // a root that will not resolve leaves the gate's answer as it came
    }
    return shell
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    const shell = await next(e)
    try {
      const cfg = await configOf($, options)
      const base = mainOf(cfg, await $.session.root())
      // the lane's own cwd; absent, the main tree
      const cwd = typeof e.cwd === 'string' ? e.cwd : base
      const { value: pending = [] } = await $.state.get({ plugin: 'lane-blame', key: 'held', id: e.agent_id })
      if (pending.length > 0) {
        await $.state.set({ plugin: 'lane-blame', key: 'held', id: e.agent_id }, [])
        await record($, cfg, base, pending.map(p => resolve(cwd, p)), e.agent_id)
      }
      if (e.stop_hook_active) return shell
      // a subagent gate may only advise: its additionalContext is the shell's raise, a block outranks it
      await judge($, cfg, base, e.agent_id, shell.block ?? shell.additionalContext?.join('\n'), treeOf(cfg, base, cwd))
    } catch {
      // as above, the gate's answer stands
    }
    return shell
  }).catch(($, e, next) => next(e))

  // the status entry is redrawn from the last judged stop at every main-loop turn end, so it
  // survives a hot reload and clears once a stop judges the record clean
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) $.ui.status(statusOf((await $.state.get(LAST)).value))
    return next(e)
  }).catch(($, e, next) => next(e))
}
