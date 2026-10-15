import type { AgentInfo, AgentSpawnInput, PluginOptions, Register } from 'claude-code'

// every repo-specific value is a userConfig option, the defaults in plugin.json and here alike
export type Config = {
  paceFile: string
  quietCap: number
  seatAgent: string
  seatModel: string
  agentsDir: string
  ladder: boolean
  briefScript: string
  briefTimeoutMs: number
  bundleDir: string
  bundlePrefix: string
  briefPattern: string
}
export const DEFAULTS: Config = {
  paceFile: '.claude/state/pace',
  quietCap: 2,
  // empty turns the seat rule off, so a fresh install refuses no model
  seatAgent: '',
  seatModel: 'fable',
  agentsDir: '.claude/agents',
  ladder: false,
  briefScript: '',
  briefTimeoutMs: 10_000,
  bundleDir: '.claude/features',
  bundlePrefix: 'CC',
  briefPattern: '',
}
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d)
const num = (v: unknown, d: number, floor = 1) => (typeof v === 'number' && Number.isFinite(v) && v >= floor ? v : d)
// a missing or mistyped option falls back to its default, never to a crash
export const configOf = (o: PluginOptions | undefined): Config => ({
  paceFile: str(o?.paceFile, DEFAULTS.paceFile).trim() || DEFAULTS.paceFile,
  // a cap of zero is a real setting, every spawn refused under quiet
  quietCap: Math.floor(num(o?.quietCap, DEFAULTS.quietCap, 0)),
  seatAgent: str(o?.seatAgent, DEFAULTS.seatAgent).trim(),
  seatModel: SEATS.includes(str(o?.seatModel, '') as never) ? (o?.seatModel as string) : DEFAULTS.seatModel,
  agentsDir: str(o?.agentsDir, DEFAULTS.agentsDir).replace(/\/+$/, ''),
  ladder: typeof o?.ladder === 'boolean' ? o.ladder : DEFAULTS.ladder,
  briefScript: str(o?.briefScript, DEFAULTS.briefScript).trim(),
  briefTimeoutMs: num(o?.briefTimeoutMs, DEFAULTS.briefTimeoutMs),
  bundleDir: str(o?.bundleDir, DEFAULTS.bundleDir).replace(/\/+$/, ''),
  bundlePrefix: str(o?.bundlePrefix, DEFAULTS.bundlePrefix).trim() || DEFAULTS.bundlePrefix,
  briefPattern: str(o?.briefPattern, DEFAULTS.briefPattern).trim(),
})
// set at register, so a reload with new options reads them whole
let C: Config = DEFAULTS
// a lane costs the machine while pending, mid-turn, or held on its own background work
const LIVE: ReadonlyArray<AgentInfo['status']> = ['pending', 'running', 'waiting']
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)
// the seat model by whole word, so fable, fable[1m], and claude-fable-5 all read
const seatRe = () => new RegExp(`\\b${esc(C.seatModel)}\\b`, 'i')
// a relative path reads under the session root, an absolute one as given
const under = (dir: string, path: string) => (path.startsWith('/') ? path : `${dir}/${path}`)

const paceOf = (root: () => Promise<string>, read: (path: string) => Promise<string>) =>
  root()
    .then(dir => read(under(dir, C.paceFile)))
    .then(
      word => (typeof word === 'string' && word.trim() === 'wide' ? 'wide' : 'quiet'),
      // no pace file reads wide, so a fresh install caps nothing
      () => 'wide',
    )

const liveOf = async (list: () => Promise<AgentInfo[]>, except?: string) =>
  (await list()).filter(agent => agent.id !== except && LIVE.includes(agent.status))

// AgentSpawnInput.model is the Agent tool's model param as given, alias or full id, unresolved
// here; undefined defers to the agent file, then the parent
const asksForFable = (model: string | undefined) =>
  typeof model === 'string' && seatRe().test(model)

type Home = () => Promise<string | undefined>
const noHome: Home = async () => undefined
// the model: line of an agent's frontmatter, the project folder first and ~/.claude/agents after.
// found is false when neither holds a file, a built-in whose own model this cannot read
const pinOf = async (
  root: () => Promise<string>,
  read: (path: string) => Promise<string>,
  type: string,
  home: Home,
): Promise<{ found: boolean; pin?: string }> => {
  if (!/^[\w-]+$/.test(type)) return { found: false }
  const pinIn = (text: string) => /^---\n([\s\S]*?)\n---/.exec(text)?.[1]?.match(/^model:\s*(\S+)/m)?.[1]
  const project = await root()
    .then(dir => read(`${under(dir, C.agentsDir)}/${type}.md`))
    .catch(() => undefined)
  if (typeof project === 'string') return { found: true, pin: pinIn(project) }
  const dir = await home().catch(() => undefined)
  const user = dir === undefined || dir === '' ? undefined : await read(`${dir}/.claude/agents/${type}.md`).catch(() => undefined)
  return typeof user === 'string' ? { found: true, pin: pinIn(user) } : { found: false }
}

// the session's subagent model from settings env, as the 2.1.300 resolver reads it: the plain
// CLAUDE_CODE_SUBAGENT_MODEL names the model, CLAUDE_CODE_SUBAGENT_MODEL_FORCE is a flag that makes
// the plain value outrank every pin. order and quotes in the README, its one home
export type SessionModel = { force?: boolean; plain?: string }
// empty and inherit read unset, since the engine runs the parent's model on an inherit value
const setOf = (value: string | undefined) => {
  const v = value?.trim()
  return v === undefined || v === '' || /^inherit$/i.test(v) ? undefined : v
}
// the flag is on for 1, true, or yes, any case, and its value is never a model
const flagOf = (value: string | undefined) => /^(1|true|yes)$/i.test(value?.trim() ?? '')
const isInherit = (model: string | undefined) => model !== undefined && /^inherit$/i.test(model)
// a forced child's source in deny text: the flag, and the plain value it forced or the parent's
const forcedBy = (env: SessionModel, parentModel: string) =>
  env.plain === undefined
    ? `CLAUDE_CODE_SUBAGENT_MODEL_FORCE, a flag that is on and, with CLAUDE_CODE_SUBAGENT_MODEL unset, forces the parent's model "${parentModel}" on every subagent`
    : `CLAUDE_CODE_SUBAGENT_MODEL_FORCE, a flag that is on and forces CLAUDE_CODE_SUBAGENT_MODEL "${env.plain}" on every subagent`

// the model ladder: a lane's own spawn goes one tier down. tiers by
// whole word, case-blind, so an alias, a [1m] suffix, and a full id like claude-opus-5-5 all read.
// a string naming none, or two, is no tier
const TIER = ['haiku', 'sonnet', 'opus', 'fable'] as const
// haiku is no seat, since a refused spawn has no lower model to be told
const SEATS = ['sonnet', 'opus', 'fable'] as const
const tierOf = (model: string) => {
  const hits = TIER.filter(name => new RegExp(`\\b${name}\\b`, 'i').test(model))
  return hits.length === 1 ? TIER.indexOf(hits[0]!) : undefined
}
// what a refused child may pass instead, one tier down or lower, haiku the floor
const PASSES = ['model: "haiku"', 'model: "haiku"', 'model: "sonnet" or "haiku"', 'model: "opus", "sonnet", or "haiku"']
type From = 'pin' | 'pin inherit' | 'agent file' | 'file inherit' | 'forced' | 'env' | 'inherited' | 'fork'
// the child's model as the engine resolves it, the order in the README: a fork the parent's, a
// call's inherit the parent's even under the flag, the flag forcing the plain value or the parent's
// over every other pin, else the call's model, the agent file's pin, the plain value, the parent's
const childOf = async (
  e: AgentSpawnInput,
  root: () => Promise<string>,
  read: (path: string) => Promise<string>,
  env: SessionModel,
  home: Home = noHome,
): Promise<{ model: string; from: From; unread?: boolean }> => {
  if (e.fork) return { model: e.parentModel, from: 'fork' }
  if (isInherit(e.model)) return { model: e.parentModel, from: 'pin inherit' }
  if (env.force) return { model: env.plain ?? e.parentModel, from: 'forced' }
  if (e.model !== undefined) return { model: e.model, from: 'pin' }
  const { found, pin } = await pinOf(root, read, e.subagentType, home)
  if (pin !== undefined)
    return /^inherit$/i.test(pin) ? { model: e.parentModel, from: 'file inherit' } : { model: pin, from: 'agent file' }
  // no file anywhere is a built-in, its own model unread, so the ladder leaves it unchecked
  const unread = found ? {} : { unread: true }
  return env.plain !== undefined
    ? { model: env.plain, from: 'env', ...unread }
    : { model: e.parentModel, from: 'inherited', ...unread }
}

// forced when the flag lands every subagent on fable, inherit when a call's inherit under the flag
// runs a fable parent while the forced model would not, asked when the call names it, resolved
// when an engine agent lands on it through childOf, so a fable coordinator's bare built-in is a
// fable lane. a plugin's agent keeps a definition this cannot read, and a fork always inherits by
// design, so neither is judged past its own ask
const fableOf = async (
  e: AgentSpawnInput,
  root: () => Promise<string>,
  read: (path: string) => Promise<string>,
  env: SessionModel,
  home: Home = noHome,
): Promise<'forced' | 'inherit' | 'asked' | 'resolved' | undefined> => {
  if (env.force) {
    if (e.fork || !seatRe().test((await childOf(e, root, read, env, home)).model)) return undefined
    // a call's inherit is the one way past the flag, so it is told only when the forced model is no fable
    return isInherit(e.model) && !seatRe().test(env.plain ?? e.parentModel) ? 'inherit' : 'forced'
  }
  if (asksForFable(e.model)) return 'asked'
  if (e.fork || e.provider.plugin !== 'engine') return undefined
  return seatRe().test((await childOf(e, root, read, env, home)).model) ? 'resolved' : undefined
}

// what a refusal on a forced model tells the caller, since no pin outranks the flag but inherit
const FORCED =
  'and the flag outranks every model: pin but "inherit", which runs the parent\'s model. Unset the flag, or run the step inline.'
// unchecked is a fail-open: a plugin agent keeps a definition this cannot read, and a model string
// of no known tier cannot be placed, so the spawn goes on with the reason on the status line
export type LadderVerdict = { deny: string } | { unchecked: string } | undefined
// parentModel rides every spawn, the main loop's included (d.ts 2.1.300), so a nested spawn is
// read from parentAgentId, absent from main. the main session's own spawns are never judged here
export const ladderCheck = async (
  e: AgentSpawnInput,
  root: () => Promise<string>,
  read: (path: string) => Promise<string>,
  env: SessionModel = {},
  home: Home = noHome,
): Promise<LadderVerdict> => {
  if (!C.ladder || e.parentAgentId === undefined) return undefined
  // a forced model places even a plugin agent, its definition never consulted
  if (e.provider.plugin !== 'engine' && !env.force)
    return {
      unchecked: `model ladder unchecked, ${e.subagentType} is a plugin agent whose model this cannot read, spawn allowed`,
    }
  const child = await childOf(e, root, read, env, home)
  const tier = tierOf(child.model)
  // the one judgment seat is the main loop's to spawn, so no pin inside a lane is the answer
  if (C.seatAgent !== '' && e.subagentType === C.seatAgent && tier === TIER.indexOf(C.seatModel as never))
    return {
      deny:
        `${C.seatAgent} is the one ${cap(C.seatModel)} judgment seat, spawned from the main loop and ` +
        'never inside a lane. Report back and let the main loop spawn it.',
    }
  if (child.unread)
    return {
      unchecked: `model ladder unchecked, ${e.subagentType} is a built-in with no agent file, its model unread, spawn allowed`,
    }
  const parent = tierOf(e.parentModel)
  if (parent === undefined)
    return { unchecked: `model ladder unchecked, parent model "${e.parentModel}" names no known tier, spawn allowed` }
  if (tier === undefined)
    return { unchecked: `model ladder unchecked, model "${child.model}" names no known tier, spawn allowed` }
  if (tier < parent || (tier === 0 && parent === 0)) return undefined
  const head =
    "The model ladder: a lane's own spawn goes one tier down, Haiku to Haiku the one " +
    `same-tier pass. The parent runs ${TIER[parent]}`
  if (child.from === 'fork')
    return {
      deny:
        `${head}, and a fork always runs its parent's model, so it cannot step down and is refused. ` +
        `Spawn a named agent with ${PASSES[parent]} instead of the fork.`,
    }
  const spawned = `${head}, and this ${e.subagentType} spawn resolves to ${TIER[tier]}`
  if (child.from === 'forced') return { deny: `${spawned} on ${forcedBy(env, e.parentModel)}, ${FORCED}` }
  // under the flag a respawn's model is dropped, so the only other child is the forced one
  if (env.force && child.from === 'pin inherit')
    return {
      deny:
        `${spawned} on its model: "inherit" pin, which runs the parent's model and is the one pin ` +
        'CLAUDE_CODE_SUBAGENT_MODEL_FORCE lets through. ' +
        (env.plain === undefined
          ? "With CLAUDE_CODE_SUBAGENT_MODEL unset the flag forces the parent's model too, so no respawn moves it. Unset the flag, or run the step inline."
          : `Respawn it with no model, and the flag runs CLAUDE_CODE_SUBAGENT_MODEL "${env.plain}" instead.`),
    }
  const how = {
    pin: `on its model: "${child.model}" pin`,
    'pin inherit': `on its model: "inherit" pin, which runs the parent's model`,
    'agent file': `on its agent file's model: ${child.model}`,
    'file inherit': `on its agent file's model: inherit, which runs the parent's model`,
    env: `on CLAUDE_CODE_SUBAGENT_MODEL "${child.model}", the session default under no pin and none in its agent file`,
    inherited: 'inherited from the parent, with no pin given and none in its agent file',
  }[child.from]
  return { deny: `${spawned} ${how}. Respawn it with ${PASSES[parent]}.` }
}

// a prompt naming a bundle's lane brief has each one counted by check-brief-size.sh before
// the lane starts, since a prose cap on brief size was followed by lanes that ran out of turns
// anyway. any .md whose name says brief, straight under a CC-<N> folder or its briefs/ folder,
// features/ before it or not, any case on the cc. a rules file or a brief-x.md outside a bundle
// folder is never a lane brief
// briefPattern, when set, replaces the pattern built from bundlePrefix; a bad one matches nothing
const briefRe = () => {
  if (C.briefPattern !== '') {
    try {
      return new RegExp(C.briefPattern, 'gi')
    } catch {
      return /$^/g
    }
  }
  return new RegExp(`[^\\s\`'"()<>[\\]]*\\b${esc(C.bundlePrefix)}-\\d+\\/(?:briefs\\/)?[\\w.-]*brief[\\w.-]*\\.md`, 'gi')
}
type Run = (argv: readonly string[], cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>
type Exists = (path: string) => Promise<boolean>
// deny is an exit 1, a brief past its caps. open is an exit 2: the brief is there and the script
// could not find the list its kind needs, so the lane would start past caps nobody counted.
// unchecked is a fail-open, a script that would not start, timed out, crashed, or met no python
export type BriefVerdict = { deny: string } | { open: string } | { unchecked: string } | undefined

// where a named brief sits: ~/ from HOME, a bare path led by bundleDir's last folder beside that
// folder, a bare <prefix>-<N>/ under bundleDir, and the folder spelled in bundlePrefix's case
const placeOf = (named: string, root: string, home?: string) => {
  const dir = under(root, C.bundleDir)
  const leaf = dir.split('/').at(-1) ?? ''
  const p = esc(C.bundlePrefix)
  const at =
    named.startsWith('~/') && home !== undefined
      ? `${home}${named.slice(1)}`
      : named.startsWith('/')
        ? named
        : leaf !== '' && named.toLowerCase().startsWith(`${leaf.toLowerCase()}/`)
          ? `${dir.slice(0, -leaf.length)}${named}`
          : new RegExp(`^${p}-\\d+\\/`, 'i').test(named)
            ? `${dir}/${named}`
            : `${root}/${named}`
  return at.replace(new RegExp(`(^|\\/)${p}-(\\d+)\\/`, 'i'), `$1${C.bundlePrefix}-$2/`)
}

// every distinct brief the prompt names
export const briefsIn = (prompt: string, root: string, home?: string) =>
  [...new Set(prompt.match(briefRe()) ?? [])].map(named => ({ named, path: placeOf(named, root, home) }))

export const briefCheck = async (
  prompt: string,
  root: string,
  run: Run,
  exists: Exists,
  home?: string,
): Promise<BriefVerdict> => {
  const deny: string[] = []
  const open: string[] = []
  const unchecked: string[] = []
  for (const { named, path } of briefsIn(prompt, root, home)) {
    // a brief named but not on disk is one the lane is asked to write, never one to count
    if (!(await exists(path).catch(() => true))) {
      unchecked.push(`found no ${named} on disk`)
      continue
    }
    // a script that cannot start or hangs fails open, the same as a throw anywhere in the hook
    const ran = await run(['bash', under(root, C.briefScript), path], root).catch(() => undefined)
    if (ran === undefined) unchecked.push(`could not run on ${named}`)
    // a breach always prints its line on stdout, so an exit 1 with none is a crash, a python
    // traceback on stderr, and the brief is not at fault
    else if (ran.exitCode === 1 && ran.stdout.trim() === '') {
      const last = ran.stderr.trim().split('\n').at(-1)?.trim()
      unchecked.push(`crashed on ${named}, exit 1 with no breach line${last ? `: ${last}` : ''}`)
    } else if (ran.exitCode === 1) deny.push(ran.stdout.trim())
    // the parse line goes to stderr; an empty one still names the exit
    else if (ran.exitCode === 2) open.push(ran.stderr.trim() || ran.stdout.trim() || `check-brief-size: ${named}: exit 2, no output`)
    // anything past 2 is the environment, no python, so the brief is not at fault
    else if (ran.exitCode !== 0) unchecked.push(`could not read ${named}, exit ${ran.exitCode}`)
  }
  if (deny.length > 0) return { deny: [...deny, ...open].join('\n') }
  if (open.length > 0) return { open: open.join('\n') }
  if (unchecked.length > 0) return { unchecked: `brief-size check ${unchecked.join('; ')}, spawn allowed` }
  return undefined
}

// one pace.verdict.<kind> store key per spawn judged, holding the last session, the time, and a running
// count, so whether the mod has acted sits on disk and not only in a status entry nobody reads. written off the gating path: a spawn never waits on the store, and a store
// that fails costs the record and nothing else.
// brief is an over-cap deny, brief-open an exit 2 refusal, brief-unchecked a fail-open on disk.
// ladder is a nested spawn at or above its parent's tier, resume a wake, written beside the pace
// key the woken run still meets
type Verdict =
  | 'fable'
  | 'ladder'
  | 'brief'
  | 'brief-open'
  | 'brief-unchecked'
  | 'resume'
  | 'cap'
  | 'wide'
  | 'quiet'
type Store = { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void> }
const verdictKey = (v: Verdict) => `pace.verdict.${v}`
const countOf = (v: unknown) =>
  typeof v === 'object' && v !== null && typeof (v as { count?: unknown }).count === 'number'
    ? (v as { count: number }).count
    : 0
// one queue, so two spawns in a turn never read the same count and both write count + 1
let queue: Promise<unknown> = Promise.resolve()
export const record = (store: Store, session: () => Promise<string>, now: () => Promise<number>, verdict: Verdict) => {
  queue = queue
    .then(async () => {
      const key = verdictKey(verdict)
      const count = countOf(await store.get(key)) + 1
      await store.set(key, { session: await session(), at: await now(), count })
    })
    .catch(() => undefined)
  return queue
}

export const register: Register = (on, options) => {
  C = configOf(options)
  on('agent.spawn', async ($, e, next) => {
    const store: Store = { get: k => $.store.get(k), set: (k, v) => $.store.set(k, v) }
    const mark = (v: Verdict) => void record(store, () => $.session.id(), () => $.clock.now(), v)
    // every fail-open reason, ladder then brief, prefixed to each pace entry after it
    const notes: string[] = []
    // since 2.1.300 a SendMessage wake raises agent.spawn with resume.agentId. a resume ignores a
    // changed model and a hook can only refuse it, which parks the run without moving it, so the
    // fable, ladder, and brief checks skip it and it meets the pace read alone, its own id out of
    // the live count since its row may still read running
    const resumed = e.resume?.agentId
    if (resumed === undefined) {
      // names spelled literally so validate lists them; an env that will not answer reads unset
      const env: SessionModel = {
        force: flagOf(await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL_FORCE').catch(() => undefined)),
        plain: setOf(await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL').catch(() => undefined)),
      }
      const userHome: Home = () => $.env.get('HOME').catch(() => undefined)
      // subagentType is the resolved type, so the critic passes on an explicit model too. no seat
      // agent means the seat rule is off
      const fable =
        C.seatAgent === '' || e.subagentType === C.seatAgent
          ? undefined
          : await fableOf(e, () => $.session.root(), path => $.fs.read(path), env, userHome)
      if (fable !== undefined) {
        mark('fable')
        $.ui.status(`${C.seatModel} subagent refused`)
        const rule = `${/^[aeiou]/i.test(C.seatModel) ? 'An' : 'A'} ${cap(C.seatModel)} pin is for a judgment seat, and ${C.seatAgent} is the only one. `
        if (fable === 'forced')
          return {
            deny: `${rule}This ${e.subagentType} spawn runs ${env.plain ?? e.parentModel} on ${forcedBy(env, e.parentModel)}, ${FORCED}`,
          }
        if (fable === 'inherit')
          return {
            deny:
              `${rule}This ${e.subagentType} spawn names model: "inherit", the one pin CLAUDE_CODE_SUBAGENT_MODEL_FORCE ` +
              `lets through, and runs the parent's ${e.parentModel}. Respawn it with no model, and the flag runs ` +
              `CLAUDE_CODE_SUBAGENT_MODEL "${env.plain}" instead.`,
          }
        // inside a lane the respawn meets the ladder next, so it is told the parent's passes
        const parent = e.parentAgentId === undefined ? undefined : tierOf(e.parentModel)
        return {
          deny: `${rule}Respawn this ${e.subagentType} lane with ${parent === undefined ? `model: "${TIER[Math.max(TIER.indexOf(C.seatModel as never) - 1, 0)]}"` : PASSES[parent]}.`,
        }
      }
      // after the fable rule, the top rung, and before the brief so a refused rung runs no script
      const ladder = await ladderCheck(e, () => $.session.root(), path => $.fs.read(path), env, userHome)
      if (ladder !== undefined && 'deny' in ladder) {
        mark('ladder')
        $.ui.status('model ladder, spawn refused')
        return { deny: ladder.deny }
      }
      if (ladder !== undefined) notes.push(ladder.unchecked)
      // no brief named means no root read and no script; no root means no script to find
      // match on a global regex resets its own lastIndex, where test would carry it to the next spawn
      const named = C.briefScript !== '' && e.prompt.match(briefRe()) !== null
      const root = named ? await $.session.root().catch(() => undefined) : undefined
      // HOME only for a ~/ brief, so a prompt without one reads no variable
      const home =
        named && /(^|[^\w.-])~\//.test(e.prompt) ? await $.env.get('HOME').catch(() => undefined) : undefined
      // a brief named under a root the engine would not give is a fail-open, never a silent pass
      const brief: BriefVerdict = !named
        ? undefined
        : root === undefined
          ? { unchecked: 'brief-size check found no session root to run from, spawn allowed' }
          : await briefCheck(
              e.prompt,
              root,
              (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: C.briefTimeoutMs }),
              path => $.fs.exists(path),
              home,
            )
      if (brief !== undefined && 'deny' in brief) {
        mark('brief')
        $.ui.status('brief over its caps, spawn refused')
        return {
          deny:
            `${brief.deny}\nThe brief is past the brief-size caps ${C.briefScript} counts, its header names ` +
            'them, so the lane would likely run out of turns. Split it into two briefs, or correct a ' +
            'declaration the list disagrees with, then respawn.',
        }
      }
      if (brief !== undefined && 'open' in brief) {
        mark('brief-open')
        $.ui.status('brief the size check could not parse, spawn refused')
        return {
          deny:
            `${brief.open}\nThe brief-size check could not count this brief, so it refuses rather than start a lane ` +
            'nobody measured. Give the list a heading the script reads, or add a ' +
            '<!-- brief-size: N groups, M files --> line, then respawn. One common brief whose lanes each get ' +
            'their owned files in the prompt is that shape: it passes only with the declaration, since the ' +
            'files it would count are not in the brief.',
        }
      }
      if (brief !== undefined) {
        mark('brief-unchecked')
        notes.push(brief.unchecked)
      }
    } else mark('resume')
    // a fail-open rides every pace entry after it, so the next status write cannot erase it
    const say = (text: string) => $.ui.status([...notes, text].join('; '))
    if ((await paceOf(() => $.session.root(), path => $.fs.read(path))) === 'wide') {
      mark('wide')
      say('pace wide')
      return next(e)
    }
    const live = await liveOf(() => $.agent.list(), resumed)
    if (live.length < C.quietCap) {
      mark('quiet')
      say(`pace quiet, ${live.length + 1} of ${C.quietCap} lanes`)
      return next(e)
    }
    mark('cap')
    // the engine's own status word rides each name, so a slot held by a lane that looked finished
    // carries what the engine reported for it
    const names = live.map(agent => `${agent.type} ${agent.id} "${agent.description}" is ${agent.status}`).join('; ')
    say(`pace quiet, ${live.length} of ${C.quietCap} lanes, spawn refused`)
    return {
      deny:
        `pace is quiet and ${live.length} lanes are live, the cap is ${C.quietCap}: ${names}. ` +
        'Wait for one to report or run the step inline' +
        `; write wide to ${C.paceFile} to lift the cap.` +
        (resumed === undefined ? '' : ` This wakes ${resumed}, whose own slot is left out of the count.`),
    }
  }).catch(($, e, next) => next(e)) // a guard that throws fails open, the spawn goes on

  // every turn end redraws the entry from the live count, so a refusal pinned mid-turn never
  // outlives the turn it belongs to: wide and an empty quiet clear it outright
  on('turn.complete', async ($, e, next) => {
    if ((await paceOf(() => $.session.root(), path => $.fs.read(path))) === 'wide') {
      $.ui.status(undefined)
      return next(e)
    }
    const live = await liveOf(() => $.agent.list(), e.agentId)
    $.ui.status(live.length === 0 ? undefined : `pace quiet, ${live.length} of ${C.quietCap} lanes`)
    return next(e)
  }).catch(($, e, next) => next(e)) // a redraw that throws never holds the turn
}
