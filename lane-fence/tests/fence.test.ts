import { expect, mock, test as bare } from 'claude-code/testing'
import type { Engine, TestBody, TestOptions } from 'claude-code/testing'
import type { AgentInfo, On, TurnCompleteInput } from 'claude-code'

// a namespace import, so the file still loads against a register without these exports
import * as fence from '../hooks/register'

// the old harness's options, what most cases here run under; a default case calls bare
const HARNESS = {
  agentTypes: 'code-reviewer,performance-reviewer,security-auditor,voice-reviewer,design-critic',
  recordFolders: '.claude/features/CC-*/',
}
function test(name: string, body: TestBody): void
function test(name: string, opts: TestOptions, body: TestBody): void
function test(name: string, a: TestBody | TestOptions, b?: TestBody) {
  if (typeof a === 'function') return bare(name, { options: HARNESS }, a)
  return bare(name, { ...a, options: { ...HARNESS, ...a.options } }, b!)
}

const agent = (id: string, type: string): AgentInfo => ({ id, type, status: 'running', description: `lane ${id}` })

// the file system as $.fs.stat answers it: a path is there and lands where it is spelled, but
// under a link, which lands where the link points; a missing path rejects ENOENT, as the engine
// does, a link that leads nowhere stats with no realPath, and realPath comes only with resolve.
// refused rejects a path with its own reason, statted logs every path asked, and noStat leaves
// fs.stat with no hook at all. the clock is a mocked one unless noClock leaves $.clock unanswered
type Tree = {
  links?: Record<string, string>
  missing?: (path: string) => boolean
  dangling?: readonly string[]
  refused?: Record<string, string>
  statted?: string[]
  noStat?: boolean
  noClock?: boolean
}
const landing = (path: string, links: Record<string, string>) => {
  const link = Object.keys(links)
    .sort((a, b) => b.length - a.length)
    .find(from => path === from || path.startsWith(`${from}/`))
  return link === undefined ? path : `${links[link]}${path.slice(link.length)}`
}

// the engine beneath the mod: the session's agents by their spawned type, the tree, tools that run
function engine(on: On, ran: string[] = [], status: Array<string | undefined> = [], tree: Tree = {}) {
  const clock = tree.noClock === true ? undefined : mock.clock(on)
  if (tree.noStat !== true) {
    on('fs.stat', (_, e) => {
      tree.statted?.push(e.path)
      if (tree.dangling?.includes(e.path)) return { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: true } }
      const refused = tree.refused?.[e.path]
      if (refused !== undefined) return { deny: refused }
      if (tree.missing?.(e.path)) return { deny: 'ENOENT' }
      const realPath = landing(e.path, tree.links ?? {})
      const isLink = realPath !== e.path
      return {
        value: e.resolve ? { kind: 'file', size: 1, mtimeMs: 0, isLink, realPath } : { kind: 'file', size: 1, mtimeMs: 0, isLink },
      }
    })
  }
  on('agent.list', () => ({
    value: [
      agent('rev', 'code-reviewer'),
      agent('perf', 'performance-reviewer'),
      agent('sec', 'security-auditor'),
      agent('voice', 'voice-reviewer'),
      agent('critic', 'design-critic'),
      agent('lane', 'general-purpose'),
    ],
  }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.status', (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', (_, e) => {
    ran.push(e.tool === 'Bash' ? e.command : e.tool)
    return { result: { ok: true } }
  })
  return clock
}

const turn = (agentId?: string): TurnCompleteInput => ({
  answer: 'done',
  durationMs: 1,
  isAborted: false,
  turnId: 'turn_test',
  reason: 'answer',
  ...(agentId === undefined ? {} : { agentId }),
})

const bash = (command: string, agentId?: string) => ({
  tool: 'Bash' as const,
  tool_use_id: 'toolu_test',
  command,
  ...(agentId === undefined ? {} : { agentId }),
})

const write = (file_path: string, agentId?: string) => ({
  tool: 'Write' as const,
  tool_use_id: 'toolu_test',
  file_path,
  content: 'x',
  ...(agentId === undefined ? {} : { agentId }),
})

test('each of the five reviewer types is fenced, read from the agent list by id', async ($, on) => {
  engine(on)
  for (const id of ['rev', 'perf', 'sec', 'voice', 'critic']) {
    const done = await $.tool.call(bash('echo x > src/lib/pool.ts', id))
    expect(done.deny, id).toContain('/repo/src/lib/pool.ts')
  }
})

test('a non-reviewer, the main loop, and an unlisted id write anywhere', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  expect((await $.tool.call(bash('echo hi > src/x.ts && git commit -am wip', 'lane'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('rm -rf src'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('echo x > src/x.ts', 'fork-1'))).deny).toBeUndefined()
  expect(ran).toHaveLength(3)
})

test('the Bash half alone: a reviewer Write passes this mod for a tool permission or settings hook to judge', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  expect((await $.tool.call(write('/repo/src/x.ts', 'rev'))).deny).toBeUndefined()
  expect(ran).toEqual(['Write'])
})

test('a reviewer writing Bash outside its record is denied, shape by shape', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  for (const command of [
    'echo x > src/x.ts',
    'cat notes >> /repo/src/x.ts',
    'echo x &> src/x.ts',
    'echo x >&src/x.ts',
    'echo x | tee -a src/x.ts',
    "sed -i 's/a/b/' src/x.ts",
    "sed -i.bak -e 's/a/b/' src/x.ts",
    'mv src/x.ts /tmp/x.ts',
    'cp /tmp/x.ts src/x.ts',
    'cp -t src /tmp/x.ts',
    'rm -f src/x.ts',
    'touch src/x.ts',
    'mkdir -m 755 src/new',
    'ln -sf /tmp/x.ts src/x.ts',
    'install -m 644 /tmp/x.ts src/x.ts',
    'truncate -s 0 src/x.ts',
    'dd if=/tmp/x.ts of=src/x.ts',
    "perl -pi -e 's/a/b/' src/x.ts",
    `python3 -c "open('src/x.ts', 'w').write('x')"`,
    `node -e "require('fs').writeFileSync('src/x.ts', 'x')"`,
    "bash -c 'echo x > src/x.ts'",
  ])
    expect((await $.tool.call(bash(command, 'rev'))).deny, command).toBeDefined()
  expect(ran).toEqual([])
})

test('git commit of unowned paths is denied, every spelling', async ($, on) => {
  engine(on)
  for (const [command, named] of [
    ['git commit -am wip', "'git commit -a'"],
    ['git commit -m wip', "'git commit with no pathspec'"],
    ['git commit --all -m wip', "'git commit --all'"],
    ['git commit --amend --no-edit -- .claude/features/CC-145/review.md', "'git commit --amend'"],
    ['git add -A', "'git add -A'"],
    ['git add :/', "'git add :/'"],
    ['git stash', "'git stash'"],
    ['git reset --hard', "'git reset'"],
    ['git checkout -- src/x.ts', "'git checkout'"],
  ]) {
    const done = await $.tool.call(bash(command ?? '', 'rev'))
    expect(done.deny, command).toContain(named)
  }
  const pathed = await $.tool.call(bash('git commit -m "fix the pool" -- src/lib/pool.ts', 'voice'))
  expect(pathed.deny).toContain('/repo/src/lib/pool.ts is outside its record paths')
  expect((await $.tool.call(bash('git add src/lib/pool.ts', 'voice'))).deny).toBeDefined()
})

test('a reviewer commits its own record by pathspec', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  const ok = [
    'git add .claude/features/CC-145/review-code.md',
    'git commit -m "review: CC-145 code" -- .claude/features/CC-145/review-code.md',
    'git -C /repo commit -m wip -- .claude/agent-memory/code-reviewer/inbox/CC-145-a.md',
    'git stash list',
    'git log --oneline -5',
  ]
  for (const command of ok) expect((await $.tool.call(bash(command, 'rev'))).deny, command).toBeUndefined()
  expect(ran).toEqual(ok)
})

test('the record paths pass: features/CC-NNN, its own memory and inbox, the tmp dirs, devices', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  const ok = [
    'echo x > .claude/features/CC-145/review.md',
    'cat <<EOF > /repo/.claude/agent-memory/code-reviewer/inbox/CC-145-a.md\nsrc > lies\nEOF',
    'echo x >> .claude/agent-memory/code-reviewer/a-note.md',
    'cp src/x.ts tmp/x.ts',
    'git diff main -- src/x.ts > /tmp/claude-1000/scratch/diff.txt',
    'pnpm test 2>/dev/null | head',
    'grep -rn "a > b" src 2>&1 | head',
    'sed -n 1,20p src/x.ts',
    'pnpm test >&2',
    'echo x >&-',
  ]
  for (const command of ok) expect((await $.tool.call(bash(command, 'rev'))).deny, command).toBeUndefined()
  expect(ran).toEqual(ok)
})

test("a reviewer cannot write another reviewer's memory, nor a non-CC features dir", async ($, on) => {
  engine(on)
  expect((await $.tool.call(bash('echo x > .claude/agent-memory/code-reviewer/note.md', 'voice'))).deny).toBeDefined()
  expect((await $.tool.call(bash('echo x > .claude/features/_template/plan.md', 'voice'))).deny).toBeDefined()
})

test('the record paths are anchored at the session root, a lookalike deeper down or elsewhere is denied', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  for (const command of [
    'echo x > /repo/src/.claude/features/CC-1/evil.ts',
    'echo x > /other/.claude/features/CC-1/review.md',
    'echo x > /repo/src/.claude/agent-memory/code-reviewer/note.md',
    'echo x > /repo/.claude/features/CC-evil.ts',
  ])
    expect((await $.tool.call(bash(command, 'rev'))).deny, command).toMatch(/outside its record paths/)
  // a reviewer lane in one of the repo's own worktrees writes its record there
  const lane = 'echo x > /repo/.claude/worktrees/agent-a/.claude/features/CC-145/review.md'
  expect((await $.tool.call(bash(lane, 'rev'))).deny).toBeUndefined()
  expect(ran).toEqual([lane])
})

test('a dot-dot target cannot climb out of the record path', async ($, on) => {
  engine(on)
  expect((await $.tool.call(bash('echo x > .claude/features/CC-145/../../../src/x.ts', 'rev'))).deny).toContain('/repo/src/x.ts')
})

test('an absolute cd is resolved and the relative targets after it judged where they land', async ($, on) => {
  engine(on)
  expect((await $.tool.call(bash('cd /tmp && echo x > a.md', 'rev'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('cd /repo/.claude && echo x > features/CC-145/review.md', 'rev'))).deny).toBeUndefined()
  const sed = await $.tool.call(bash("cd /repo && sed -i 's/a/b/' src/x.ts", 'rev'))
  expect(sed.deny).toContain('/repo/src/x.ts')
  expect((await $.tool.call(bash('cd /tmp && echo x > /repo/src/x.ts', 'rev'))).deny).toBeDefined()
})

test('a relative write after any other cd is refused with the reason', async ($, on) => {
  engine(on)
  for (const command of [
    'cd .claude/features/CC-145 && echo x > review.md',
    'cd "$HOME" && echo x > a.md',
    'cd ~ && echo x > a.md',
    'cd && echo x > a.md',
    'cd - && echo x > a.md',
    'pushd /tmp && echo x > a.md',
    '(cd /tmp && true) && echo x > src/x.ts',
    'cd src && git add x.ts',
  ]) {
    const done = await $.tool.call(bash(command, 'rev'))
    expect(done.deny, command).toContain('relative write after a cd')
  }
  // an absolute target after any cd is still judged by its own path
  expect((await $.tool.call(bash('cd src && echo x > /tmp/a.md', 'rev'))).deny).toBeUndefined()
})

test('the path deny lists the record paths with an Oxford or', async ($, on) => {
  engine(on)
  const done = await $.tool.call(bash('echo x > src/x.ts', 'voice'))
  expect(done.deny).toBe(
    'fence: voice-reviewer is a read-only reviewer and /repo/src/x.ts is outside its record paths. ' +
      "Write only under .claude/features/CC-*/, .claude/agent-memory/voice-reviewer/, the session root's tmp/, or /tmp/. " +
      'Report the fix as text with path:line and let the caller apply it.',
  )
})

test("a refusal's status entry clears at the main loop's turn end, not a subagent's", async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, [], status)
  await $.tool.call(bash('echo x > src/x.ts', 'rev'))
  expect(status.at(-1)).toBe('fence refused code-reviewer: /repo/src/x.ts')
  await $.turn.complete(turn('rev'))
  expect(status.at(-1)).toBe('fence refused code-reviewer: /repo/src/x.ts')
  await $.turn.complete(turn())
  expect(status.at(-1)).toBe(undefined)
})

test('a fence that throws fails open', async ($, on) => {
  const ran: string[] = []
  on('agent.list', () => {
    throw new Error('agent list unavailable')
  })
  on('tool.call', (_, e) => {
    ran.push(e.tool === 'Bash' ? e.command : e.tool)
    return { result: { ok: true } }
  })
  expect((await $.tool.call(bash('echo x > src/x.ts', 'rev'))).deny).toBeUndefined()
  expect(ran).toEqual(['echo x > src/x.ts'])
})

// a heredoc or here-string body fed to an interpreter reading
// stdin is its script, and wrappers sit between the shell and that interpreter
const TARGET = 'src/lib/pool.ts'
const W = `open('${TARGET}', 'w').write('x')`

test('a python3 - heredoc that writes is denied and names the path', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  const done = await $.tool.call(bash(`python3 - <<'EOF'\nfrom pathlib import Path\nPath('${TARGET}').write_text('x')\nEOF`, 'rev'))
  expect(done.deny).toContain(`/repo/${TARGET}`)
  expect(done.deny).toContain('inline python3 script')
  expect(ran).toEqual([])
})

test('a bare python3 heredoc that writes is denied', async ($, on) => {
  engine(on)
  expect((await $.tool.call(bash(`python3 <<EOF\n${W}\nEOF`, 'rev'))).deny).toContain(`/repo/${TARGET}`)
})

test('a node - here-string that writes is denied', async ($, on) => {
  engine(on)
  const done = await $.tool.call(bash(`node - <<<"require('fs').writeFileSync('${TARGET}', 'x')"`, 'rev'))
  expect(done.deny).toContain(`/repo/${TARGET}`)
  expect(done.deny).toContain('inline node script')
})

test('a heredoc piped from cat into python3 is its script', async ($, on) => {
  engine(on)
  expect((await $.tool.call(bash(`cat <<'EOF' | python3\n${W}\nEOF`, 'rev'))).deny).toContain(`/repo/${TARGET}`)
})

test('the same stdin scripts reading only pass', async ($, on) => {
  engine(on)
  for (const command of [
    `python3 - <<'EOF'\nprint(open('${TARGET}').read())\nEOF`,
    `python3 <<EOF\nprint(open('${TARGET}', 'r').read())\nEOF`,
    `node - <<<"console.log(require('fs').readFileSync('${TARGET}', 'utf8'))"`,
    `cat <<'EOF' | python3\nprint(open('${TARGET}').read())\nEOF`,
  ]) {
    expect((await $.tool.call(bash(command, 'rev'))).deny, command).toBeUndefined()
  }
})

test('a writing heredoc behind timeout is denied', async ($, on) => {
  engine(on)
  for (const command of [`timeout 60 python3 - <<'EOF'\n${W}\nEOF`, `timeout -s KILL 5m python3 - <<'EOF'\n${W}\nEOF`]) {
    expect((await $.tool.call(bash(command, 'rev'))).deny, command).toContain(`/repo/${TARGET}`)
  }
})

test('a writing heredoc behind uv run is denied', async ($, on) => {
  engine(on)
  for (const command of [`uv run python - <<'EOF'\n${W}\nEOF`, `uv run --with requests python3.12 - <<'EOF'\n${W}\nEOF`]) {
    expect((await $.tool.call(bash(command, 'rev'))).deny, command).toContain(`/repo/${TARGET}`)
  }
})

test('a writing -c behind env, timeout, or nice is denied', async ($, on) => {
  engine(on)
  for (const command of [`env python3 -c "${W}"`, `env -u HOME python3 -c "${W}"`, `timeout 60 python3 -c "${W}"`, `nice -n 10 python3 -c "${W}"`]) {
    expect((await $.tool.call(bash(command, 'rev'))).deny, command).toContain('inline python3 script')
  }
})

test('a wrapped interpreter that only reads passes', async ($, on) => {
  engine(on)
  for (const command of [
    `timeout 60 python3 - <<'EOF'\nprint(open('${TARGET}').read())\nEOF`,
    `uv run python - <<'EOF'\nprint(open('${TARGET}').read())\nEOF`,
    `env python3 -c "print(open('${TARGET}').read())"`,
  ]) {
    expect((await $.tool.call(bash(command, 'rev'))).deny, command).toBeUndefined()
  }
})

test('the command after a here-string survives the strip', async ($, on) => {
  engine(on)
  for (const command of ['cat <<< "note"; rm -rf src/lib', 'cat <<< "note"\nrm -rf src/lib', 'cat<<<note; rm -rf src/lib']) {
    expect((await $.tool.call(bash(command, 'rev'))).deny, command).toContain('/repo/src/lib')
  }
})

test('two heredocs on one line are each read by the command that opens them', async ($, on) => {
  engine(on)
  const second = await $.tool.call(bash(`cat > /tmp/n.md <<'A'; python3 - <<'B'\nnote\nA\n${W}\nB`, 'rev'))
  expect(second.deny).toContain(`/repo/${TARGET}`)
  // the writing body here is cat's data, the python body only prints
  expect((await $.tool.call(bash(`python3 - <<'A'; cat > /tmp/n.md <<'B'\nprint(1)\nA\n${W}\nB`, 'rev'))).deny).toBeUndefined()
  // and the command after both bodies is still judged
  expect((await $.tool.call(bash(`cat <<'A' <<'B'\na\nA\nb\nB\nrm src/x.ts`, 'rev'))).deny).toContain('/repo/src/x.ts')
})

test('the rest of a heredoc opener line is still scanned', async ($, on) => {
  engine(on)
  expect((await $.tool.call(bash(`cat <<'EOF' > src/x.ts\nx\nEOF`, 'rev'))).deny).toContain('/repo/src/x.ts')
})

test('the deny names the path the script writes, not the first path it reads', async ($, on) => {
  engine(on)
  const done = await $.tool.call(bash(`python3 - <<'EOF'\ns = open('src/a.ts').read()\nopen('${TARGET}', 'w').write(s)\nEOF`, 'rev'))
  expect(done.deny).toContain(`/repo/${TARGET}`)
  expect(done.deny).not.toContain('/repo/src/a.ts')
})

test('a heredoc script writing only into the record is still denied, and never pointed at the Write tool', async ($, on) => {
  engine(on)
  const done = await $.tool.call(bash(`python3 - <<'EOF'\nopen('/tmp/review.md', 'w').write('x')\nEOF`, 'rev'))
  expect(done.deny).toContain('writes files this fence cannot place')
  expect(done.deny).not.toContain('Write tool')
  expect(done.deny).toContain("Write only under .claude/features/CC-*/, .claude/agent-memory/code-reviewer/, the session root's tmp/, or /tmp/. Report")
})

test('a write call in a heredoc no interpreter reads is data and passes', async ($, on) => {
  engine(on)
  expect((await $.tool.call(bash(`cat <<'EOF' > /tmp/note.md\n${W}\nEOF`, 'rev'))).deny).toBeUndefined()
})

test('known passes: a script run from a file, and a heredoc fed to bash', async ($, on) => {
  engine(on)
  for (const command of [
    'python3 scripts/rewrite.py',
    `python3 scripts/rewrite.py <<'EOF'\n${W}\nEOF`,
    `bash <<'EOF'\necho x > ${TARGET}\nEOF`,
  ]) {
    expect((await $.tool.call(bash(command, 'rev'))).deny, command).toBeUndefined()
  }
})

test('a writing heredoc from a non-reviewer passes', async ($, on) => {
  engine(on)
  expect((await $.tool.call(bash(`python3 - <<'EOF'\n${W}\nEOF`, 'lane'))).deny).toBeUndefined()
})

// a write is placed where it lands, $.fs.stat's realPath, and only
// an ENOENT climbs to the folder; the normalized spelling is never the fallback
test('a symlink under the record path pointing outside it is denied, judged where it lands', async ($, on) => {
  const ran: string[] = []
  engine(on, ran, [], { links: { '/repo/.claude/features/CC-148/notes.md': '/repo/src/x.ts' } })
  const done = await $.tool.call(bash('echo x > .claude/features/CC-148/notes.md', 'rev'))
  expect(done.deny).toContain('/repo/.claude/features/CC-148/notes.md, which lands at /repo/src/x.ts,')
  expect(done.deny).toContain('outside its record paths')
  expect((await $.tool.call(bash("sed -i 's/a/b/' /repo/.claude/features/CC-148/notes.md", 'rev'))).deny).toBeDefined()
  expect(ran).toEqual([])
})

test('a Bash redirect through a link and .. is judged where the shell writes it', async ($, on) => {
  const ran: string[] = []
  engine(on, ran, [], { links: { '/repo/tmp/s': '/repo/src/sub' } })
  expect((await $.tool.call(bash('echo x > /repo/tmp/s/../x.ts', 'rev'))).deny).toContain(
    '/repo/tmp/x.ts, which lands at /repo/src/x.ts,',
  )
  expect((await $.tool.call(bash('echo x > tmp/s/../x.ts', 'rev'))).deny).toContain('which lands at /repo/src/x.ts,')
  // a .. through no link folds where it reads
  expect((await $.tool.call(bash('echo x > /repo/src/../tmp/a.md', 'rev'))).deny).toBeUndefined()
  expect(ran).toEqual(['echo x > /repo/src/../tmp/a.md'])
})

test('a new file under a linked folder in the record is judged where the folder lands', async ($, on) => {
  engine(on, [], [], { links: { '/repo/tmp/s': '/repo/src' }, missing: p => p.startsWith('/repo/src/new') })
  const done = await $.tool.call(bash('touch /repo/tmp/s/new/x.ts', 'rev'))
  expect(done.deny).toContain('which lands at /repo/src/new/x.ts,')
})

test('a new file in the record passes once its folder places it, a new folder too', async ($, on) => {
  const ran: string[] = []
  engine(on, ran, [], { missing: p => p.endsWith('/review-new.md') || p.includes('/inbox/new') })
  const ok = [
    'echo x > .claude/features/CC-148/review-new.md',
    'echo x > .claude/agent-memory/code-reviewer/inbox/new/a.md',
  ]
  for (const command of ok) expect((await $.tool.call(bash(command, 'rev'))).deny, command).toBeUndefined()
  expect(ran).toEqual(ok)
})

test('a link that leads nowhere is unplaced and denied', async ($, on) => {
  engine(on, [], [], { dangling: ['/repo/.claude/features/CC-148/gone.md'] })
  const done = await $.tool.call(bash('echo x > .claude/features/CC-148/gone.md', 'rev'))
  expect(done.deny).toContain('cannot place /repo/.claude/features/CC-148/gone.md')
  expect(done.deny).toContain('a link that leads nowhere')
})

test('a session root and /tmp behind links are resolved the same way and stay record paths', async ($, on) => {
  engine(on, [], [], { links: { '/repo': '/real/repo', '/tmp': '/private/tmp' } })
  expect((await $.tool.call(bash('echo x > /repo/tmp/notes.md', 'rev'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('echo x > /tmp/claude-1000/a.md', 'rev'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('echo x > .claude/features/CC-148/review.md', 'rev'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('echo x > /repo/src/x.ts', 'rev'))).deny).toContain('which lands at /real/repo/src/x.ts,')
})

test('a tree where nothing stats denies, the spelling is never the fallback', async ($, on) => {
  const ran: string[] = []
  engine(on, ran, [], { missing: () => true })
  const done = await $.tool.call(bash('echo x > .claude/features/CC-148/review.md', 'rev'))
  expect(done.deny).toContain('cannot place /repo/.claude/features/CC-148/review.md, since nothing on the path')
  expect(ran).toEqual([])
})

test('a refused stat denies with its reason and never climbs to the folder', async ($, on) => {
  const ran: string[] = []
  const statted: string[] = []
  const leaf = '/repo/.claude/features/CC-148/review.md'
  engine(on, ran, [], { refused: { [leaf]: 'EACCES: permission denied' }, statted })
  const done = await $.tool.call(bash(`echo x > ${leaf}`, 'rev'))
  expect(done.deny).toContain(`the stat of ${leaf} was refused`)
  expect(done.deny).toContain('EACCES: permission denied')
  expect(statted).toEqual([leaf])
  expect(ran).toEqual([])
})

test('no stat hook at all denies a record write as refused', async ($, on) => {
  const ran: string[] = []
  engine(on, ran, [], { noStat: true })
  const done = await $.tool.call(bash('echo x > .claude/features/CC-148/review.md', 'rev'))
  expect(done.deny).toContain('was refused')
  expect(ran).toEqual([])
})

test('a reviewer Bash call that writes nothing stats nothing, root and /tmp placed once', async ($, on) => {
  const statted: string[] = []
  engine(on, [], [], { statted })
  expect((await $.tool.call(bash('git log --oneline -5', 'rev'))).deny).toBeUndefined()
  expect(statted).toEqual([])
  await $.tool.call(bash('echo x > /tmp/a.md; echo y > /tmp/b.md', 'rev'))
  expect(statted.filter(p => p === '/repo' || p === '/tmp')).toEqual(['/repo', '/tmp'])
})

test("a link from the root's tmp/ into another tree's record folders is denied", async ($, on) => {
  engine(on, [], [], {
    links: { '/repo/tmp/f': '/other/.claude/features/CC-1', '/repo/tmp/m': '/other/.claude/agent-memory/code-reviewer' },
  })
  expect((await $.tool.call(bash('echo x > /repo/tmp/f/review.md', 'rev'))).deny).toContain(
    'which lands at /other/.claude/features/CC-1/review.md,',
  )
  expect((await $.tool.call(bash('echo x > /repo/tmp/m/note.md', 'rev'))).deny).toContain(
    'which lands at /other/.claude/agent-memory/code-reviewer/note.md,',
  )
})

// a hard link is refused outright, a symbolic link only
// with a write through it in the same call, since a link made in an earlier call is placed by the
// next call's stat
test('a hard link maker is refused outright, ln without -s and cp -l', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  for (const [command, named] of [
    ['ln /repo/src/x.ts tmp/h', 'ln'],
    ['ln -f /repo/src/x.ts tmp/h', 'ln'],
    ['cp -l /repo/src/x.ts tmp/h', 'cp -l'],
    ['cp -al /repo/src tmp/d', 'cp -l'],
    ['cp --link /repo/src/x.ts tmp/h', 'cp --link'],
  ]) {
    const done = await $.tool.call(bash(command ?? '', 'rev'))
    expect(done.deny, command).toContain(`may not run '${named ?? ''}', since a hard link is the file it names`)
  }
  expect(ran).toEqual([])
})

test('a symbolic link with a write through it in the same call is refused, a lone one is judged as a write', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  for (const [command, named, through] of [
    ['ln -s /repo/src/x.ts .claude/features/CC-148/n.md && echo x > .claude/features/CC-148/n.md', 'ln -s', '/repo/.claude/features/CC-148/n.md'],
    ['ln -s /repo/src .claude/features/CC-148/d && echo x > .claude/features/CC-148/d/x.ts', 'ln -s', '/repo/.claude/features/CC-148/d/x.ts'],
    ['ln -sf /repo/src tmp/d; cp /tmp/x.ts tmp/d/', 'ln -s', '/repo/tmp/d'],
    ['ln -s /repo/src/a tmp/d && echo x > tmp/d/../x.ts', 'ln -s', '/repo/tmp/x.ts'],
    ['ln -s /repo/src tmp/d && mv tmp/d tmp/e', 'ln -s', '/repo/tmp/d'],
    ['for i in 1 2; do echo x > tmp/d/x.ts; ln -s /repo/src tmp/d; done', 'ln -s', '/repo/tmp/d/x.ts'],
    ['cp -s /repo/src/x.ts tmp/n.md && echo x > tmp/n.md', 'cp -s', '/repo/tmp/n.md'],
    ['ln -s /repo/src tmp/d && echo x > "$OUT"', 'ln -s', '$OUT'],
  ]) {
    const done = await $.tool.call(bash(command ?? '', 'rev'))
    expect(done.deny, command).toContain(`may not run '${named ?? ''}' with a write to ${through ?? ''} in the same call`)
  }
  expect(ran).toEqual([])
  const ok = [
    'ln -s /repo/src/x.ts .claude/features/CC-148/n.md',
    'ln -s /repo/src tmp/d && echo x > tmp/notes.md',
    'ln -s /repo/src tmp/d && rm tmp/d',
    'cd /repo/tmp && ln -s /repo/src/x.ts',
    'cp -s /repo/src/x.ts tmp/n.md',
  ]
  for (const command of ok) expect((await $.tool.call(bash(command, 'rev'))).deny, command).toBeUndefined()
  expect(ran).toEqual(ok)
  // the destination is a plain write, so a link made outside the record is refused as one
  expect((await $.tool.call(bash('ln -s /tmp/x.ts src/x.ts', 'rev'))).deny).toContain('/repo/src/x.ts is outside its record paths')
})

test('coreutils link is a hard link and is refused outright', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  const done = await $.tool.call(bash('link /repo/src/x.ts /tmp/h', 'rev'))
  expect(done.deny).toContain("may not run 'link', since a hard link is the file it names")
  expect(ran).toEqual([])
})

test('a glued cp -t or -S value carrying an l or s is no link flag', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  const ok = ['cp -ttmp/lists /repo/src/x.ts', 'cp -S.sl /repo/src/x.ts tmp/x.ts', 'cp -fttmp/lists /repo/src/x.ts']
  for (const command of ok) expect((await $.tool.call(bash(command, 'rev'))).deny, command).toBeUndefined()
  expect(ran).toEqual(ok)
  // the glued -t folder is the destination judged
  expect((await $.tool.call(bash('cp -tsrc/lib /tmp/x.ts', 'rev'))).deny).toContain('/repo/src/lib is outside its record paths')
})

test('a .. through a link to a device-named path is placed, never skipped as a device', async ($, on) => {
  const ran: string[] = []
  engine(on, ran, [], { links: { '/repo/tmp/s': '/repo/src/a/b' } })
  expect((await $.tool.call(bash('echo x > /repo/tmp/s/../../../dev/null', 'rev'))).deny).toContain(
    'which lands at /repo/dev/null,',
  )
  // a plain device and a .. that truly lands on one still pass
  const ok = ['pnpm test 2>/dev/null', 'echo x > /repo/tmp/../../dev/null']
  for (const command of ok) expect((await $.tool.call(bash(command, 'rev'))).deny, command).toBeUndefined()
  expect(ran).toEqual(ok)
})

test('a script path under a linked root is placed before the record test', async ($, on) => {
  engine(on, [], [], { links: { '/repo': '/real/repo', '/tmp': '/private/tmp' } })
  const record = await $.tool.call(bash(`python3 - <<'EOF'\nopen('/repo/.claude/features/CC-148/x.md', 'w').write('x')\nEOF`, 'rev'))
  expect(record.deny).toContain('writes files this fence cannot place')
  expect(record.deny).not.toContain('outside its record paths')
  const out = await $.tool.call(bash(`python3 - <<'EOF'\nopen('src/x.ts', 'w').write('x')\nEOF`, 'rev'))
  expect(out.deny).toContain('names /repo/src/x.ts, which lands at /real/repo/src/x.ts, outside its record paths')
})

test('a stat that never settles is refused at the deadline, the call never held', async ($, on) => {
  const ran: string[] = []
  const clock = engine(on, ran, [], { noStat: true })
  on('fs.stat', () => new Promise<never>(() => undefined))
  const call = $.tool.call(bash('echo x > .claude/features/CC-148/review.md', 'rev'))
  // the two-second deadline, spelled here so a register without it hangs red
  await clock?.advance(2000)
  const done = await call
  expect(done.deny).toContain('the stat of /repo/.claude/features/CC-148/review.md was refused, stat timed out')
  expect(ran).toEqual([])
})

test('a stat rejecting with the ENOENT code and no ENOENT text reads missing', async () => {
  const never = () => new Promise<string>(() => undefined)
  const stat = fence.statOf(() => Promise.reject({ code: 'ENOENT' }), never)
  expect(await stat('/repo/new.md')).toBe('missing')
  expect(await fence.statOf(() => Promise.reject({ code: 'EACCES' }), never)('/repo/x.md')).toEqual({ refused: '[object Object]' })
})

test('rm and mv judge a link where it sits, a mv of a link is refused as one made', async ($, on) => {
  const ran: string[] = []
  engine(on, ran, [], {
    links: { '/repo/tmp/l': '/repo/src/x.ts', '/repo/tmp/dir': '/repo/src' },
    dangling: ['/repo/tmp/gone'],
  })
  const ok = ['rm /repo/tmp/l', 'rm -f tmp/gone', 'rm tmp/dir', 'mv tmp/a.md tmp/b.md']
  for (const command of ok) expect((await $.tool.call(bash(command, 'rev'))).deny, command).toBeUndefined()
  expect(ran).toEqual(ok)
  // through the link, a trailing slash, or into a linked folder is still judged where it lands
  expect((await $.tool.call(bash('rm tmp/dir/x.ts', 'rev'))).deny).toContain('which lands at /repo/src/x.ts,')
  expect((await $.tool.call(bash('rm -r tmp/dir/', 'rev'))).deny).toContain('which lands at /repo/src,')
  expect((await $.tool.call(bash('mv tmp/a.md tmp/dir', 'rev'))).deny).toContain('which lands at /repo/src,')
  expect((await $.tool.call(bash('mv tmp/l .claude/features/CC-148/n.md', 'rev'))).deny).toContain(
    "may not run 'mv' on the link /repo/tmp/l",
  )
})

// a copy that keeps an existing link as a link lands
// it the way ln -s makes one, so `cp -P /repo/src-link tmp/n.md && echo x > tmp/n.md` writes
// through it into src. refused with a write under its destination in the same call, else judged
async function keeps(
  $: Engine,
  on: On,
  refused: Array<[string, string, string]>,
  passed: string[],
) {
  const ran: string[] = [];
  engine(on, ran);
  for (const [command, named, other] of refused) {
    const done = await $.tool.call(bash(command, "rev"));
    expect(done.deny, command).toContain(
      `may not run '${named}' with a write to ${other} in the same call`,
    );
  }
  for (const command of passed)
    expect(
      (await $.tool.call(bash(command, "rev"))).deny,
      command,
    ).toBeUndefined();
  expect(ran).toEqual(passed);
}

test("cp -P copying a link as a link is refused with a write through it, alone it passes", async ($, on) => {
  await keeps(
    $,
    on,
    [
      [
        "cp -P /repo/src-link .claude/features/CC-148/n.md && echo x > .claude/features/CC-148/n.md",
        "cp -P",
        "/repo/.claude/features/CC-148/n.md",
      ],
      [
        "cp --no-dereference /repo/src-link tmp/n.md && sed -i s/a/b/ tmp/n.md",
        "cp --no-dereference",
        "/repo/tmp/n.md",
      ],
    ],
    [
      "cp /repo/src/x.ts tmp/x.ts",
      "cp -P /repo/src-link tmp/n.md",
      "cp --no-dereference /repo/src-link tmp/n.md",
    ],
  );
});

test("cp -d copying a link as a link is refused with a write through it, bundled too", async ($, on) => {
  await keeps(
    $,
    on,
    [
      [
        "cp -d /repo/src-link tmp/n.md; echo x >> tmp/n.md",
        "cp -d",
        "/repo/tmp/n.md",
      ],
      [
        "cp -fd /repo/src-link tmp/n.md && touch tmp/n.md",
        "cp -d",
        "/repo/tmp/n.md",
      ],
    ],
    ["cp -d /repo/src-link tmp/n.md", "cp -fd /repo/src-link tmp/n.md"],
  );
});

test("cp -a keeping the links in a tree is refused with a write under it, -aL and a lone -a pass", async ($, on) => {
  await keeps(
    $,
    on,
    [
      [
        "cp -a /repo/node_modules tmp/nm && echo x > tmp/nm/f",
        "cp -a",
        "/repo/tmp/nm/f",
      ],
      [
        "cp --archive /repo/src tmp/s && rm tmp/s/x.ts",
        "cp --archive",
        "/repo/tmp/s/x.ts",
      ],
    ],
    [
      "cp -aL /repo/src tmp/s",
      "cp -a /repo/src tmp/s",
      "cp --archive /repo/src tmp/s && rm -r tmp/s",
    ],
  );
});

test("cp -R or -r without -L is refused with a write under it, with -L it passes, and a later -P keeps again", async ($, on) => {
  await keeps(
    $,
    on,
    [
      [
        "cp -R /repo/src tmp/s && echo x > tmp/s/x.ts",
        "cp -R",
        "/repo/tmp/s/x.ts",
      ],
      [
        "cp -rL -P /repo/src tmp/s && echo x > tmp/s/x.ts",
        "cp -P",
        "/repo/tmp/s/x.ts",
      ],
    ],
    [
      "cp -R /repo/src tmp/s",
      "cp -r /repo/src tmp/s",
      "cp -rL /repo/src tmp/s && echo x > tmp/s/x.ts",
      "cp -L -r /repo/src tmp/s",
    ],
  );
});

test("rsync -l or -a is refused with a write under it, -L copying the referent and a lone -a pass", async ($, on) => {
  await keeps(
    $,
    on,
    [
      [
        "rsync -l /repo/src-link tmp/n.md && echo x > tmp/n.md",
        "rsync -l",
        "/repo/tmp/n.md",
      ],
      [
        "rsync -avz /repo/src/ tmp/s/ && echo x > tmp/s/x.ts",
        "rsync -a",
        "/repo/tmp/s/x.ts",
      ],
    ],
    [
      "rsync -aL /repo/src/ tmp/s/",
      "rsync -avz /repo/src/ tmp/s/",
      "rsync --archive /repo/src tmp/s",
    ],
  );
});

test("tar x is refused with a write under its folder, alone into the record it passes, a listing and a create too", async ($, on) => {
  await keeps(
    $,
    on,
    [
      [
        "tar xzf /tmp/a.tgz -C .claude/features/CC-148 && echo x > .claude/features/CC-148/x.md",
        "tar x",
        "/repo/.claude/features/CC-148/x.md",
      ],
      [
        "tar -C tmp -xzf /tmp/a.tgz; cat tmp/f > tmp/sub/g",
        "tar x",
        "/repo/tmp/sub/g",
      ],
    ],
    [
      "tar xzf /tmp/a.tgz -C .claude/features/CC-148",
      "tar --extract -f /tmp/a.tar -C tmp",
      "tar -C tmp -xzf /tmp/a.tgz",
      "tar --directory=tmp -xf /tmp/a.tar",
      "tar -tf /tmp/a.tar",
      "tar cf /tmp/x.tar src",
    ],
  );
});

test("tar x with no -C extracts where it runs, judged there", async ($, on) => {
  engine(on);
  expect((await $.tool.call(bash("tar -xf /tmp/a.tar", "rev"))).deny).toContain(
    "/repo is outside its record paths",
  );
  expect(
    (await $.tool.call(bash("cd /tmp && tar -xf /tmp/a.tar", "rev"))).deny,
  ).toBeUndefined();
});

// each link refusal ends on a way through that fits it
test("each link refusal ends on its own way through, never a plain cp for a tar or an mv", async ($, on) => {
  engine(on, [], [], { links: { "/repo/tmp/l": "/repo/src/x.ts" } });
  const tail = async (command: string) =>
    (await $.tool.call(bash(command, "rev"))).deny ?? "";
  const tar = await tail("tar -xf /tmp/a.tar -C tmp && echo x > tmp/x.md");
  expect(tar).toContain("Run the extraction alone and write in the next call");
  expect(tar).not.toContain("plain cp");
  const mv = await tail("mv tmp/l tmp/m");
  expect(mv).toContain("Copy what it points at with cp -L instead");
  expect(mv).not.toContain("plain cp");
  expect(await tail("ln -s /repo/src tmp/d && echo x > tmp/d/x.ts")).toContain(
    "Make the link in one call and write in the next",
  );
  expect(await tail("cp -a /repo/src tmp/s && echo x > tmp/s/x.ts")).toContain(
    "follow the links with cp -rL or rsync -L",
  );
  expect(await tail("ln /repo/src/x.ts tmp/h")).toContain(
    "Copy with a plain cp",
  );
});

// the stat deadline is bounded once from the hook's budget, and a refused
// timer refuses the stat at once instead of holding the call
test("the stat deadline is the budget less a margin, capped at two seconds, refused under the margin", async () => {
  const asked: number[] = [];
  const sleep = (ms: number) => {
    asked.push(ms);
    return new Promise<void>(() => undefined);
  };
  const signal = new AbortController().signal;
  void fence.deadlineOf(Number.POSITIVE_INFINITY, sleep, signal);
  void fence.deadlineOf(10_000, sleep, signal);
  void fence.deadlineOf(2500, sleep, signal);
  expect(asked).toEqual([2000, 2000, 1500]);
  expect(await fence.deadlineOf(900, sleep, signal)).toBe(
    "the hook has 900 ms of budget left",
  );
  expect(asked).toHaveLength(3);
  const never = () => new Promise<{ realPath?: string }>(() => undefined);
  const spent = fence.statOf(never, () => fence.deadlineOf(0, sleep, signal));
  expect(await spent("/repo/x.md")).toEqual({
    refused: "the hook has 0 ms of budget left",
  });
});

test("a refused timer refuses a stalled stat at once, the call never held", async ($, on) => {
  const ran: string[] = [];
  engine(on, ran, [], { noStat: true, noClock: true });
  on("fs.stat", () => new Promise<never>(() => undefined));
  on("clock.sleep", () => ({ deny: "no timers here" }));
  on("clock.after", () => ({ deny: "no timers here" }));
  const done = await $.tool.call(
    bash("echo x > .claude/features/CC-148/review.md", "rev"),
  );
  expect(done.deny).toContain("the stat deadline was refused");
  expect(done.deny).toContain("no timers here");
  expect(ran).toEqual([]);
});

// the userConfig options: each proven at its default and at a value of its own
const passes = async ($: Engine, command: string, id = 'rev') => (await $.tool.call(bash(command, id))).deny

bare('agentTypes defaults to empty, so the fence binds no agent until one is named', async ($, on) => {
  engine(on)
  for (const id of ['rev', 'perf', 'sec', 'voice', 'critic', 'lane']) {
    expect(await passes($, 'echo x > src/x.ts', id)).toBeUndefined()
  }
})

test('agentTypes set to the five reviewer types fences them and lets other agents through', async ($, on) => {
  engine(on)
  expect(await passes($, 'echo x > src/x.ts', 'critic')).toContain('design-critic is a read-only reviewer')
  expect(await passes($, 'echo x > src/x.ts', 'lane')).toBeUndefined()
})

bare('agentTypes set to one type fences that type alone', { options: { agentTypes: 'general-purpose' } }, async ($, on) => {
  engine(on)
  expect(await passes($, 'echo x > src/x.ts', 'lane')).toContain('general-purpose is a read-only reviewer')
  expect(await passes($, 'echo x > src/x.ts', 'rev')).toBeUndefined()
})

bare('recordFolders defaults to .claude/reviews/, so a fenced code-reviewer may write its review there', { options: { agentTypes: 'code-reviewer' } }, async ($, on) => {
  engine(on)
  expect(await passes($, 'echo ok > .claude/reviews/r.md')).toBeUndefined()
  const done = await passes($, 'echo x > .claude/features/CC-1/r.md')
  expect(done).toContain('Write only under .claude/reviews/,')
  expect(done).not.toContain('CC-*')
})

test('recordFolders set to the old harness folder opens .claude/features/CC-*/ only', async ($, on) => {
  engine(on)
  expect(await passes($, 'echo x > .claude/features/CC-1/r.md')).toBeUndefined()
  expect(await passes($, 'echo x > docs/reviews/r.md')).toContain('outside its record paths')
})

test('recordFolders set to its own patterns opens those and closes the default', { options: { recordFolders: 'docs/reviews/, out/PR-*/' } }, async ($, on) => {
  engine(on)
  expect(await passes($, 'echo x > docs/reviews/r.md')).toBeUndefined()
  expect(await passes($, 'echo x > out/PR-12/r.md')).toBeUndefined()
  expect(await passes($, 'echo x > out/r.md')).toContain('outside its record paths')
  const done = await passes($, 'echo x > .claude/features/CC-1/r.md')
  expect(done).toContain('Write only under docs/reviews/, out/PR-*/,')
})

test('memoryRoot default opens .claude/agent-memory/<type>/', async ($, on) => {
  engine(on)
  expect(await passes($, 'echo x > .claude/agent-memory/code-reviewer/n.md')).toBeUndefined()
  expect(await passes($, 'echo x > notes/agents/code-reviewer/n.md')).toBeDefined()
})

test('memoryRoot set moves the own-memory path, still never a sibling', { options: { memoryRoot: 'notes/agents' } }, async ($, on) => {
  engine(on)
  expect(await passes($, 'echo x > notes/agents/code-reviewer/n.md')).toBeUndefined()
  expect(await passes($, 'echo x > notes/agents/voice-reviewer/n.md')).toBeDefined()
  expect(await passes($, 'echo x > .claude/agent-memory/code-reviewer/n.md')).toBeDefined()
})

test('worktreesDir default anchors a record path inside .claude/worktrees/<name>/', async ($, on) => {
  engine(on)
  expect(await passes($, 'echo x > /repo/.claude/worktrees/a/.claude/features/CC-1/r.md')).toBeUndefined()
  expect(await passes($, 'echo x > /repo/wt/a/.claude/features/CC-1/r.md')).toBeDefined()
})

test('worktreesDir set anchors inside its own folder instead', { options: { worktreesDir: 'wt' } }, async ($, on) => {
  engine(on)
  expect(await passes($, 'echo x > /repo/wt/a/.claude/features/CC-1/r.md')).toBeUndefined()
  expect(await passes($, 'echo x > /repo/.claude/worktrees/a/.claude/features/CC-1/r.md')).toBeDefined()
})

test("rootTmp default opens the session root's tmp/", async ($, on) => {
  engine(on)
  expect(await passes($, 'echo x > tmp/a.md')).toBeUndefined()
  expect(await passes($, 'echo x > scratch/a.md')).toBeDefined()
})

test("rootTmp set opens its own folder under the root and names it in the deny", { options: { rootTmp: 'scratch' } }, async ($, on) => {
  engine(on)
  expect(await passes($, 'echo x > scratch/a.md')).toBeUndefined()
  const done = await passes($, 'echo x > tmp/a.md')
  expect(done).toContain("the session root's scratch/")
})

test('systemTmp default opens /tmp/', async ($, on) => {
  engine(on)
  expect(await passes($, 'echo x > /tmp/a.md')).toBeUndefined()
  expect(await passes($, 'echo x > /var/tmp/a.md')).toBeDefined()
})

test('systemTmp set opens its own absolute folder and closes /tmp/', { options: { systemTmp: '/var/tmp' } }, async ($, on) => {
  const statted: string[] = []
  engine(on, [], [], { statted })
  expect(await passes($, 'echo x > /var/tmp/a.md')).toBeUndefined()
  expect(await passes($, 'echo x > /tmp/a.md')).toContain('or /var/tmp/.')
  expect(statted).not.toContain('/tmp')
})

test('statDeadlineMs default waits two seconds on a stalled stat', async ($, on) => {
  const clock = engine(on, [], [], { noStat: true })
  on('fs.stat', () => new Promise<never>(() => undefined))
  let settled = false
  const call = $.tool.call(bash('echo x > tmp/a.md', 'rev')).then(done => {
    settled = true
    return done
  })
  await clock?.advance(500)
  expect(settled).toBe(false)
  await clock?.advance(1500)
  expect((await call).deny).toContain('stat timed out')
})

test('statDeadlineMs set refuses a stalled stat at its own deadline', { options: { statDeadlineMs: 500 } }, async ($, on) => {
  const clock = engine(on, [], [], { noStat: true })
  on('fs.stat', () => new Promise<never>(() => undefined))
  const call = $.tool.call(bash('echo x > tmp/a.md', 'rev'))
  await clock?.advance(500)
  expect((await call).deny).toContain('stat timed out')
})

// the per-repo block: the project and local settings files, as $.settings.read answers each
// source, a source left out answering {} the way a missing file does. reads logs every source asked
type Sources = { project?: unknown; local?: unknown; fails?: readonly string[]; reads?: string[] }
const sources = (on: On, s: Sources) =>
  on('settings.read', (_, e) => {
    const source = e.source ?? 'merged'
    s.reads?.push(source)
    if (s.fails?.includes(source)) return { deny: `${source} settings unreadable` }
    const value = source === 'project' ? s.project : source === 'local' ? s.local : undefined
    return { value: (value ?? {}) as Record<string, unknown> }
  })
const block = (key: string, options: Record<string, unknown>) => ({ pluginConfigs: { [key]: { options } } })
const USER = { agentTypes: 'code-reviewer', recordFolders: '.claude/reviews/' }

bare('a project block field wins over the user value, local over project', { options: USER }, async ($, on) => {
  engine(on)
  sources(on, {
    project: block('lane-fence@claude-lanes', { agentTypes: 'security-auditor', recordFolders: 'docs/reviews/' }),
    local: block('lane-fence', { agentTypes: 'general-purpose' }),
  })
  // local names the fenced type, so neither the user's nor the project's is fenced
  expect(await passes($, 'echo x > src/x.ts', 'lane')).toContain('general-purpose is a read-only reviewer')
  expect(await passes($, 'echo x > src/x.ts', 'rev')).toBeUndefined()
  expect(await passes($, 'echo x > src/x.ts', 'sec')).toBeUndefined()
  // local sets no record folder, so the project's stands over the user's
  expect(await passes($, 'echo x > docs/reviews/r.md', 'lane')).toBeUndefined()
  expect(await passes($, 'echo x > .claude/reviews/r.md', 'lane')).toContain('Write only under docs/reviews/,')
})

bare('a wrong-typed project field is ignored and the user value stands', { options: USER }, async ($, on) => {
  engine(on)
  sources(on, {
    project: block('lane-fence@claude-lanes', {
      agentTypes: 7,
      recordFolders: ['docs/reviews/', 'out/PR-*/'],
      systemTmp: false,
      memoryRoot: ['notes'],
      statDeadlineMs: '500',
    }),
  })
  expect(await passes($, 'echo x > src/x.ts', 'rev')).toContain('code-reviewer is a read-only reviewer')
  expect(await passes($, 'echo x > src/x.ts', 'lane')).toBeUndefined()
  // a list option takes a JSON array, the field beside a wrong one still wins
  expect(await passes($, 'echo x > out/PR-3/r.md')).toBeUndefined()
  expect(await passes($, 'echo x > /tmp/a.md')).toBeUndefined()
  expect(await passes($, 'echo x > .claude/agent-memory/code-reviewer/n.md')).toBeUndefined()
  expect(await passes($, 'echo x > notes/code-reviewer/n.md')).toContain('outside its record paths')
})

bare('a wrong-typed project number is ignored and the user deadline stands', { options: { ...USER, statDeadlineMs: 500 } }, async ($, on) => {
  const clock = engine(on, [], [], { noStat: true })
  on('fs.stat', () => new Promise<never>(() => undefined))
  sources(on, { project: block('lane-fence@claude-lanes', { statDeadlineMs: '3000' }) })
  let settled = false
  const call = $.tool.call(bash('echo x > tmp/a.md', 'rev')).then(done => {
    settled = true
    return done
  })
  // the user's 500 holds, a string 3000 taken would read the two-second default
  await clock?.advance(500)
  expect(settled).toBe(true)
  expect((await call).deny).toContain('stat timed out')
})

test('no project block changes nothing', async ($, on) => {
  engine(on)
  sources(on, {
    project: { pluginConfigs: { 'lane-blame@claude-lanes': { options: { agentTypes: 'general-purpose' } }, 'lane-fencer': { options: { agentTypes: '' } } } },
    local: { permissions: { allow: [] } },
  })
  expect(await passes($, 'echo x > src/x.ts', 'voice')).toContain('voice-reviewer is a read-only reviewer')
  expect(await passes($, 'echo x > src/x.ts', 'lane')).toBeUndefined()
  expect(await passes($, 'echo x > .claude/features/CC-1/r.md', 'voice')).toBeUndefined()
})

test('a settings read that rejects leaves the user options standing', async ($, on) => {
  engine(on)
  sources(on, { local: block('lane-fence', { agentTypes: '' }), fails: ['project', 'local'] })
  expect(await passes($, 'echo x > src/x.ts', 'voice')).toContain('voice-reviewer is a read-only reviewer')
  expect(await passes($, 'echo x > .claude/features/CC-1/r.md', 'voice')).toBeUndefined()
})

test('the project block is read once per session, never on each Bash call', async ($, on) => {
  const reads: string[] = []
  engine(on)
  sources(on, { project: block('lane-fence@claude-lanes', { recordFolders: 'docs/reviews/' }), reads })
  // the main loop reads no config, so it pays no read
  await $.tool.call(bash('echo x > src/x.ts'))
  expect(reads).toEqual([])
  await Promise.all([passes($, 'echo x > docs/reviews/a.md'), passes($, 'echo x > docs/reviews/b.md', 'perf')])
  expect(await passes($, 'echo x > .claude/features/CC-1/r.md', 'sec')).toContain('Write only under docs/reviews/,')
  expect(reads).toEqual(['project', 'local'])
})

// the reconcile's code findings, each red against 1.0.0
test('an unplaceable target is refused, a home path, a variable, or a substitution', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  for (const [command, named] of [
    ['echo x > ~/x.ts', '~/x.ts'],
    ['echo x | tee $OUT', '$OUT'],
    ['echo x > "$(pwd)/src/x.ts"', '$(pwd)/src/x.ts'],
    ['touch `pwd`/src/x.ts', '`pwd`/src/x.ts'],
  ]) {
    const done = await $.tool.call(bash(command ?? '', 'rev'))
    expect(done.deny, command).toContain(`this fence cannot place ${named ?? ''}, since`)
  }
  expect(ran).toEqual([])
})

test('git branch and tag that move a ref are refused, a bare listing passes', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  for (const [command, named] of [
    ['git branch -f main HEAD~1', "'git branch'"],
    ['git branch -D old', "'git branch'"],
    ['git branch new-work', "'git branch'"],
    ['git branch -v new-work', "'git branch'"],
    ['git tag v9', "'git tag'"],
    ['git tag -a v9 -m release', "'git tag'"],
    ['git tag -d v1', "'git tag'"],
    ['git update-ref refs/heads/main HEAD~1', "'git update-ref'"],
  ]) {
    const done = await $.tool.call(bash(command ?? '', 'rev'))
    expect(done.deny, command).toContain(`may not run ${named ?? ''}`)
  }
  expect(ran).toEqual([])
  const ok = [
    'git branch',
    'git branch -a -vv',
    "git branch --list 'ln-*'",
    'git branch --contains HEAD',
    'git branch --show-current',
    'git tag',
    "git tag -l 'v1*'",
    'git tag -n v1',
  ]
  for (const command of ok) expect((await $.tool.call(bash(command, 'rev'))).deny, command).toBeUndefined()
  expect(ran).toEqual(ok)
})

test('a plain rsync is judged as a write to its destination', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  expect((await $.tool.call(bash('rsync /tmp/x.ts src/x.ts', 'rev'))).deny).toContain('/repo/src/x.ts is outside its record paths')
  expect((await $.tool.call(bash('rsync -r /tmp/d/ src/', 'rev'))).deny).toContain('/repo/src is outside its record paths')
  expect(ran).toEqual([])
  const ok = ['rsync -r /repo/src/ tmp/s/', 'rsync --list-only /repo/src/']
  for (const command of ok) expect((await $.tool.call(bash(command, 'rev'))).deny, command).toBeUndefined()
  expect(ran).toEqual(ok)
})

test("deno eval is deno's inline form, and a Deno write call is a write", async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  for (const command of [
    `deno eval "Deno.writeTextFileSync('src/x.ts', 'x')"`,
    `deno eval --ext ts "await Deno.writeFile('src/x.ts', new Uint8Array())"`,
    `deno eval "Deno.removeSync('src/x.ts')"`,
  ]) {
    expect((await $.tool.call(bash(command, 'rev'))).deny, command).toContain('inline deno script')
  }
  expect(ran).toEqual([])
  // a reading eval passes, and a python list's remove is no file write
  const ok = [`deno eval "console.log(Deno.readTextFileSync('src/x.ts'))"`, `python3 -c "a = [1]; a.remove(1)"`]
  for (const command of ok) expect((await $.tool.call(bash(command, 'rev'))).deny, command).toBeUndefined()
  expect(ran).toEqual(ok)
})
