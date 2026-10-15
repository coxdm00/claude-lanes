import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { AgentInfo, AgentSpawnInput, On, ProcessRunResult, TurnCompleteInput } from 'claude-code'

const lane = (id: string, status: AgentInfo['status']): AgentInfo => ({
  id,
  status,
  type: 'general-purpose',
  description: `lane ${id}`,
})

// the test engine's $ takes the event's whole input, not the plugin call's AgentSpawnArgs
const spawnArgs = (
  prompt: string,
  model?: string,
  subagentType = 'general-purpose',
  parentModel = 'opus',
): AgentSpawnInput => ({
  tool_use_id: 'toolu_test',
  prompt,
  description: 'test lane',
  subagentType,
  provider: { plugin: 'engine', tier: 'core' },
  ...(model === undefined ? {} : { model }),
  parentModel,
  background: true,
  fork: false,
})

// the engine beneath the mod: the pace file, the session's agents, a spawn that starts, a store
// the test can read, a session id, and a clock. the store is a map kept here, json-cloned as the
// engine does, storeFails rejects every store call beneath the mod, and rootFails the root. env is
// the whole environment, seeded every time so the runner's own CLAUDE_CODE_SUBAGENT_MODEL never leaks in
function engine(
  on: On,
  pace: string | undefined,
  agents: AgentInfo[],
  status: Array<string | undefined> = [],
  files: Record<string, string> = {},
  store: Map<string, unknown> = new Map(),
  storeFails = false,
  rootFails = false,
  env: Record<string, string> = {},
): MockClock {
  mock.env(on, env)
  on('store.get', (_, e) => (storeFails ? { deny: 'store unavailable' } : { value: store.get(e.key) }))
  on('store.set', (_, e) => {
    if (storeFails) return { deny: 'store unavailable' }
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => (rootFails ? { deny: 'no session root' } : { value: '/repo' }))
  on('fs.read', (_, e) => {
    if (e.path === '/repo/.claude/state/pace' && pace !== undefined) return { value: pace }
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('agent.list', () => ({ value: agents }))
  on('ui.status', (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('agent.spawn', () => ({ model: 'opus', agentId: 'new' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return mock.clock(on, { now: 1_000 })
}

// the main loop's turn end, no agentId
const mainTurn = (): TurnCompleteInput => ({
  answer: 'done',
  durationMs: 1,
  isAborted: false,
  turnId: 'turn_test',
  reason: 'answer',
})

// the options that reproduce the harness this mod came from, its defaults before 1.0.0
const HARNESS = {
  seatAgent: 'design-critic',
  ladder: true,
  briefScript: '.claude/hooks/lib/check-brief-size.sh',
  paceFile: '.claude/state/pace',
}
type Body = Parameters<typeof test>[1] extends infer B ? (B extends (...a: infer A) => unknown ? (...a: A) => unknown : never) : never
const harness = (name: string, body: Body) => test(name, { options: HARNESS }, body as never)

harness('quiet refuses the third live lane and names the live ones', async ($, on) => {
  engine(on, 'quiet\n', [lane('a', 'running'), lane('b', 'waiting')])
  const spawned = await $.agent.spawn(spawnArgs('review the diff'))
  expect(spawned.deny).toMatch(/the cap is 2/)
  expect(spawned.deny).toContain('lane b')
  expect(spawned.deny).toMatch(/run the step inline; write wide to \.claude\/state\/pace to lift the cap\.$/)
})

harness('wide allows the third lane', async ($, on) => {
  engine(on, 'wide', [lane('a', 'running'), lane('b', 'running'), lane('c', 'running')])
  expect((await $.agent.spawn(spawnArgs('review the diff'))).agentId).toBe('new')
})

harness('an ended lane does not count', async ($, on) => {
  engine(on, 'quiet', [lane('a', 'running'), lane('b', 'completed'), lane('c', 'killed')])
  expect((await $.agent.spawn(spawnArgs('review the diff'))).agentId).toBe('new')
})

harness('an idle agent does not count as live', async ($, on) => {
  engine(on, 'quiet', [lane('a', 'running'), lane('b', 'idle'), lane('c', 'idle')])
  expect((await $.agent.spawn(spawnArgs('review the diff'))).agentId).toBe('new')
})

harness('a missing pace word reads wide', async ($, on) => {
  engine(on, undefined, [lane('a', 'running'), lane('b', 'pending')])
  expect((await $.agent.spawn(spawnArgs('review the diff'))).agentId).toBe('new')
})

harness('a fable built-in is refused even under wide, alias, 1m, and full id alike', async ($, on) => {
  engine(on, 'wide', [])
  for (const model of ['fable', 'fable[1m]', 'claude-fable-5']) {
    const spawned = await $.agent.spawn(spawnArgs('review the diff', model))
    expect(spawned.deny).toMatch(/design-critic is the only one/)
    expect(spawned.deny).toContain('model: "opus"')
  }
  expect((await $.agent.spawn(spawnArgs('review the diff', 'fable', 'Explore'))).deny).toBeDefined()
})

harness('design-critic on fable is allowed, an omitted model under an opus parent passes for any type', async ($, on) => {
  engine(on, 'quiet', [])
  expect((await $.agent.spawn(spawnArgs('critique the shots', 'fable', 'design-critic'))).agentId).toBe('new')
  expect((await $.agent.spawn(spawnArgs('critique the shots', 'claude-fable-5', 'design-critic'))).agentId).toBe('new')
  expect((await $.agent.spawn(spawnArgs('critique the shots', undefined, 'design-critic'))).agentId).toBe('new')
  expect((await $.agent.spawn(spawnArgs('review the diff'))).agentId).toBe('new')
})

harness("a fable session's bare built-in inherits fable and is refused, the critic and a pinned agent pass", async ($, on) => {
  engine(on, 'wide', [], [], {
    '/repo/.claude/agents/code-reviewer.md': '---\nname: code-reviewer\nmodel: opus\n---\nbody',
    '/repo/.claude/agents/loose.md': '---\nname: loose\n---\nmodel: opus in the body is no pin',
  })
  const bare = await $.agent.spawn(spawnArgs('review the diff', undefined, 'general-purpose', 'fable'))
  expect(bare.deny).toMatch(/design-critic is the only one/)
  expect(bare.deny).toContain('Respawn this general-purpose lane with model: "opus"')
  expect((await $.agent.spawn(spawnArgs('look', undefined, 'Explore', 'claude-fable-5[1m]'))).deny).toBeDefined()
  expect((await $.agent.spawn(spawnArgs('look', undefined, 'loose', 'fable'))).deny).toBeDefined()
  expect((await $.agent.spawn(spawnArgs('critique the shots', undefined, 'design-critic', 'fable'))).agentId).toBe('new')
  expect((await $.agent.spawn(spawnArgs('review the diff', undefined, 'code-reviewer', 'fable'))).agentId).toBe('new')
  expect((await $.agent.spawn(spawnArgs('review the diff', 'opus', 'general-purpose', 'fable'))).agentId).toBe('new')
})

harness('design-critic on fable still counts against the quiet cap', async ($, on) => {
  engine(on, 'quiet', [lane('a', 'running'), lane('b', 'running')])
  expect((await $.agent.spawn(spawnArgs('critique the shots', 'fable', 'design-critic'))).deny).toMatch(/the cap is 2/)
})

harness('a refusal pinned to the status line clears when the turn ends', async ($, on) => {
  const status: Array<string | undefined> = []
  const agents = [lane('a', 'running'), lane('b', 'running')]
  engine(on, 'quiet', agents, status)
  await $.agent.spawn(spawnArgs('review the diff'))
  expect(status.at(-1)).toBe('pace quiet, 2 of 2 lanes, spawn refused')
  agents.splice(0, agents.length, lane('a', 'completed'), lane('b', 'completed'))
  await $.turn.complete(mainTurn())
  expect(status.at(-1)).toBe(undefined)
})

harness('a fable refusal clears at turn end under wide', async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, 'wide', [], status)
  await $.agent.spawn(spawnArgs('review the diff', 'fable'))
  expect(status.at(-1)).toBe('fable subagent refused')
  await $.turn.complete(mainTurn())
  expect(status.at(-1)).toBe(undefined)
})

harness('turn end redraws the live count while lanes still run', async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, 'quiet', [lane('a', 'running')], status)
  await $.turn.complete(mainTurn())
  expect(status.at(-1)).toBe('pace quiet, 1 of 2 lanes')
})

harness('a guard that throws fails open', async ($, on) => {
  on('session.root', () => ({ value: '/repo' }))
  on('fs.read', () => ({ value: 'quiet' }))
  on('agent.list', () => {
    throw new Error('agent list unavailable')
  })
  on('ui.status', () => ({ value: undefined }))
  on('agent.spawn', () => ({ model: 'opus', agentId: 'new' }))
  expect((await $.agent.spawn(spawnArgs('review the diff'))).agentId).toBe('new')
})

harness('a cap refusal and a fable refusal each write their own store key with session, time, and count', async ($, on) => {
  const store = new Map<string, unknown>()
  const clock = engine(on, 'quiet', [lane('a', 'running'), lane('b', 'running')], [], {}, store)
  await $.agent.spawn(spawnArgs('review the diff'))
  await $.agent.spawn(spawnArgs('review the diff'))
  await $.agent.spawn(spawnArgs('review the diff', 'fable'))
  await clock.advance(0)
  expect(store.get('lane-pace.verdict.cap')).toEqual({ session: 's1', at: 1_000, count: 2 })
  expect(store.get('lane-pace.verdict.fable')).toEqual({ session: 's1', at: 1_000, count: 1 })
  expect(store.get('lane-pace.verdict.quiet')).toBe(undefined)
  expect(store.get('lane-pace.verdict.wide')).toBe(undefined)
})

harness('a bare built-in under a fable parent writes the fable key, the critic on fable writes none', async ($, on) => {
  const store = new Map<string, unknown>()
  const clock = engine(on, 'wide', [], [], {}, store)
  await $.agent.spawn(spawnArgs('review the diff', undefined, 'general-purpose', 'fable'))
  await clock.advance(0)
  expect(store.get('lane-pace.verdict.fable')).toEqual({ session: 's1', at: 1_000, count: 1 })
  await $.agent.spawn(spawnArgs('critique the shots', 'fable', 'design-critic'))
  await clock.advance(0)
  expect(store.get('lane-pace.verdict.fable')).toEqual({ session: 's1', at: 1_000, count: 1 })
  expect(store.get('lane-pace.verdict.wide')).toEqual({ session: 's1', at: 1_000, count: 1 })
})

harness('a pass under quiet writes its key', async ($, on) => {
  const store = new Map<string, unknown>()
  const clock = engine(on, 'quiet', [], [], {}, store)
  await $.agent.spawn(spawnArgs('review the diff'))
  await clock.advance(0)
  expect(store.get('lane-pace.verdict.quiet')).toEqual({ session: 's1', at: 1_000, count: 1 })
})

harness('a pass under wide writes its key', async ($, on) => {
  const store = new Map<string, unknown>()
  const clock = engine(on, 'wide', [], [], {}, store)
  await $.agent.spawn(spawnArgs('review the diff'))
  await clock.advance(0)
  expect(store.get('lane-pace.verdict.wide')).toEqual({ session: 's1', at: 1_000, count: 1 })
})

harness('a store that fails costs the record, never the verdict', async ($, on) => {
  const clock = engine(on, 'quiet', [lane('a', 'running'), lane('b', 'running')], [], {}, new Map(), true)
  expect((await $.agent.spawn(spawnArgs('review the diff'))).deny).toMatch(/the cap is 2/)
  expect((await $.agent.spawn(spawnArgs('review the diff', 'fable'))).deny).toMatch(/design-critic is the only one/)
  await clock.advance(0)
})

harness('a store that fails never holds a passing spawn', async ($, on) => {
  const clock = engine(on, 'quiet', [], [], {}, new Map(), true)
  expect((await $.agent.spawn(spawnArgs('review the diff'))).agentId).toBe('new')
  await clock.advance(0)
})
// the brief-size script beneath the mod, answering as told per brief path, every run kept
const exited = (
  exitCode: number,
  stdout = "",
  stderr = "",
): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
});
type Answer = ProcessRunResult | "cannot start" | "timed out";
type Ran = { argv: string[]; cwd?: string; timeoutMs?: number };
// one answer for every brief, or a map from the brief path to its answer; every brief is on disk
// unless the test names the ones that are not
function script(
  on: On,
  answer: Answer | Record<string, Answer>,
  missing: string[] = [],
): Ran[] {
  const runs: Ran[] = [];
  on("fs.exists", (_, e) => ({ value: !missing.includes(e.path) }));
  on("process.run", (_, e) => {
    runs.push({
      argv: [...e.argv],
      cwd: e.init?.cwd,
      timeoutMs: e.init?.timeoutMs,
    });
    const brief = e.argv[2] ?? "";
    const said =
      typeof answer === "string" || "exitCode" in answer
        ? answer
        : (answer[brief] ?? exited(0));
    if (said === "cannot start") return { deny: "spawn bash ENOENT" };
    if (said === "timed out")
      return { deny: "process.run timed out after 10000 ms" };
    return { value: said as ProcessRunResult };
  });
  return runs;
}
const BRIEF_PROMPT =
  "Your full brief is .claude/features/CC-999/brief-A.md; read it whole first.";
const BRIEF_PATH = "/repo/.claude/features/CC-999/brief-A.md";
const BREACH =
  "check-brief-size: brief-A.md: 6 owned files for a review brief, the cap is 4 or one probe set and the files it covers";
const PARSE =
  "check-brief-size: brief-A.md: cannot parse, looked for a heading saying 'Owned files' or own, since the title '# review of the solver' names a review";

harness("a brief over its caps is denied with the script output, and the deny is recorded", async ($, on) => {
  const store = new Map<string, unknown>();
  const status: Array<string | undefined> = [];
  const clock = engine(on, "wide", [], status, {}, store);
  const runs = script(on, exited(1, `${BREACH}\n`));
  const spawned = await $.agent.spawn(spawnArgs(BRIEF_PROMPT));
  expect(spawned.agentId).toBe(undefined);
  expect(spawned.deny).toContain(BREACH);
  expect(spawned.deny).toContain(".claude/hooks/lib/check-brief-size.sh");
  expect(runs).toEqual([
    {
      argv: ["bash", "/repo/.claude/hooks/lib/check-brief-size.sh", BRIEF_PATH],
      cwd: "/repo",
      timeoutMs: 10_000,
    },
  ]);
  expect(status.at(-1)).toBe("brief over its caps, spawn refused");
  await clock.advance(0);
  expect(store.get("lane-pace.verdict.brief")).toEqual({
    session: "s1",
    at: 1_000,
    count: 1,
  });
  expect(store.get("lane-pace.verdict.wide")).toBe(undefined);
});

harness("a brief the script cannot parse, exit 2, is refused with the parse line and a brief-open key", async ($, on) => {
  const status: Array<string | undefined> = [];
  const store = new Map<string, unknown>();
  const clock = engine(on, "wide", [], status, {}, store);
  script(on, exited(2, "", `${PARSE}\n`));
  const spawned = await $.agent.spawn(spawnArgs(BRIEF_PROMPT));
  expect(spawned.agentId).toBe(undefined);
  expect(spawned.deny).toContain(PARSE);
  expect(spawned.deny).toMatch(/could not count this brief/);
  expect(spawned.deny).toContain("<!-- brief-size: N groups, M files -->");
  expect(status.at(-1)).toBe(
    "brief the size check could not parse, spawn refused",
  );
  await clock.advance(0);
  expect(store.get("lane-pace.verdict.brief-open")).toEqual({
    session: "s1",
    at: 1_000,
    count: 1,
  });
  expect(store.get("lane-pace.verdict.brief")).toBe(undefined);
  expect(store.get("lane-pace.verdict.brief-unchecked")).toBe(undefined);
});

harness("a brief under its caps passes to the pace check", async ($, on) => {
  const status: Array<string | undefined> = [];
  engine(on, "quiet", [], status);
  const runs = script(on, exited(0));
  expect((await $.agent.spawn(spawnArgs(BRIEF_PROMPT))).agentId).toBe("new");
  expect(runs).toHaveLength(1);
  expect(status.at(-1)).toBe("pace quiet, 1 of 2 lanes");
});

harness("a brief under its caps still meets the quiet cap", async ($, on) => {
  engine(on, "quiet", [lane("a", "running"), lane("b", "running")]);
  script(on, exited(0));
  expect((await $.agent.spawn(spawnArgs(BRIEF_PROMPT))).deny).toMatch(
    /the cap is 2/,
  );
});

harness("a script that cannot start or times out fails open with a status line and a brief-unchecked key", async ($, on) => {
  const status: Array<string | undefined> = [];
  const store = new Map<string, unknown>();
  const clock = engine(on, "wide", [], status, {}, store);
  script(on, {
    [BRIEF_PATH]: "cannot start",
    "/repo/.claude/features/CC-999/brief-B.md": "timed out",
  });
  expect((await $.agent.spawn(spawnArgs(BRIEF_PROMPT))).agentId).toBe("new");
  expect(status.at(-1)).toBe(
    "brief-size check could not run on .claude/features/CC-999/brief-A.md, spawn allowed; pace wide",
  );
  expect(
    (
      await $.agent.spawn(
        spawnArgs("Your brief is .claude/features/CC-999/brief-B.md."),
      )
    ).agentId,
  ).toBe("new");
  expect(status.at(-1)).toMatch(
    /could not run on .claude\/features\/CC-999\/brief-B.md, spawn allowed; pace wide/,
  );
  await clock.advance(0);
  expect(store.get("lane-pace.verdict.brief-unchecked")).toEqual({
    session: "s1",
    at: 1_000,
    count: 2,
  });
  expect(store.get("lane-pace.verdict.wide")).toEqual({
    session: "s1",
    at: 1_000,
    count: 2,
  });
  expect(store.get("lane-pace.verdict.brief-open")).toBe(undefined);
});

harness("an exit past 2 is the environment and fails open with a brief-unchecked key", async ($, on) => {
  const status: Array<string | undefined> = [];
  const store = new Map<string, unknown>();
  const clock = engine(on, "wide", [], status, {}, store);
  script(on, exited(127, "", "py3: no working python found"));
  expect((await $.agent.spawn(spawnArgs(BRIEF_PROMPT))).agentId).toBe("new");
  expect(status.at(-1)).toMatch(
    /could not read .*brief-A.md, exit 127, spawn allowed; pace wide/,
  );
  await clock.advance(0);
  expect(store.get("lane-pace.verdict.brief-unchecked")).toEqual({
    session: "s1",
    at: 1_000,
    count: 1,
  });
});

// B11: a breach always prints on stdout, so an exit 1 with none is the parser crashing
harness("an exit 1 with empty stdout is a crash that fails open with a brief-unchecked key", async ($, on) => {
  const status: Array<string | undefined> = [];
  const store = new Map<string, unknown>();
  const clock = engine(on, "wide", [], status, {}, store);
  const crash = "Traceback (most recent call last):\nKeyError: groups";
  script(on, {
    [BRIEF_PATH]: exited(1, "", `${crash}\n`),
    "/repo/.claude/features/CC-999/brief-B.md": exited(1),
  });
  const spawned = await $.agent.spawn(spawnArgs(BRIEF_PROMPT));
  expect(spawned.agentId).toBe("new");
  expect(spawned.deny).toBe(undefined);
  expect(status.at(-1)).toBe(
    "brief-size check crashed on .claude/features/CC-999/brief-A.md, exit 1 with no breach line: KeyError: groups, spawn allowed; pace wide",
  );
  expect(
    (
      await $.agent.spawn(
        spawnArgs("Your brief is .claude/features/CC-999/brief-B.md."),
      )
    ).agentId,
  ).toBe("new");
  expect(status.at(-1)).toBe(
    "brief-size check crashed on .claude/features/CC-999/brief-B.md, exit 1 with no breach line, spawn allowed; pace wide",
  );
  expect(status.join("\n")).not.toMatch(/past the brief-size caps/);
  await clock.advance(0);
  expect(store.get("lane-pace.verdict.brief-unchecked")).toEqual({
    session: "s1",
    at: 1_000,
    count: 2,
  });
  expect(store.get("lane-pace.verdict.brief")).toBe(undefined);
});

harness("an exit 2 with no output still refuses and names the exit", async ($, on) => {
  engine(on, "wide", []);
  script(on, exited(2));
  expect((await $.agent.spawn(spawnArgs(BRIEF_PROMPT))).deny).toContain(
    "check-brief-size: .claude/features/CC-999/brief-A.md: exit 2, no output",
  );
});

harness("every brief a prompt names is checked once, a bare features path read under .claude", async ($, on) => {
  engine(on, "wide", []);
  const runs = script(on, {
    "/repo/.claude/features/CC-999/brief-G.md": exited(1, BREACH),
  });
  const spawned = await $.agent.spawn(
    spawnArgs(
      "Your brief is /work/.claude/features/CC-999/brief-B.md, then read `features/CC-999/brief-G.md` and " +
        "/work/.claude/features/CC-999/brief-B.md again, and brief-M.md as an example.",
    ),
  );
  expect(runs.map((run) => run.argv[2])).toEqual([
    "/work/.claude/features/CC-999/brief-B.md",
    "/repo/.claude/features/CC-999/brief-G.md",
  ]);
  expect(spawned.deny).toContain(BREACH);
});

harness("an over-cap brief and an unparsed one beside it deny with both lines under the brief key", async ($, on) => {
  const store = new Map<string, unknown>();
  const clock = engine(on, "wide", [], [], {}, store);
  script(on, {
    [BRIEF_PATH]: exited(2, "", PARSE),
    "/repo/.claude/features/CC-999/brief-B.md": exited(1, BREACH),
  });
  const spawned = await $.agent.spawn(
    spawnArgs(`${BRIEF_PROMPT} Also .claude/features/CC-999/brief-B.md.`),
  );
  expect(spawned.deny).toContain(BREACH);
  expect(spawned.deny).toContain(PARSE);
  await clock.advance(0);
  expect(store.get("lane-pace.verdict.brief")).toEqual({
    session: "s1",
    at: 1_000,
    count: 1,
  });
  expect(store.get("lane-pace.verdict.brief-open")).toBe(undefined);
});

harness("a brief the prompt names but the disk lacks is never run and fails open", async ($, on) => {
  const status: Array<string | undefined> = [];
  engine(on, "wide", [], status);
  const runs = script(on, exited(2, "", PARSE), [BRIEF_PATH]);
  expect((await $.agent.spawn(spawnArgs(BRIEF_PROMPT))).agentId).toBe("new");
  expect(runs).toEqual([]);
  expect(status.at(-1)).toMatch(
    /found no .*brief-A.md on disk, spawn allowed; pace wide/,
  );
});

harness("a prompt naming no bundle brief never runs the script", async ($, on) => {
  engine(on, "wide", []);
  const runs = script(on, exited(1, BREACH));
  for (const prompt of [
    "review the diff, then write review-a.md and run check-brief-size.sh",
    "write your notes in brief-H1.md beside the report",
    "Read .claude/rules/brief-voice.md first, then `features/CC-<N>/brief-*.md` as the shape.",
  ]) {
    expect((await $.agent.spawn(spawnArgs(prompt))).agentId).toBe("new");
  }
  expect(runs).toEqual([]);
});

harness("a fable refusal comes before the brief check, the script never runs on it", async ($, on) => {
  engine(on, "wide", []);
  const runs = script(on, exited(1, BREACH));
  expect((await $.agent.spawn(spawnArgs(BRIEF_PROMPT, "fable"))).deny).toMatch(
    /design-critic is the only one/,
  );
  expect(runs).toEqual([]);
});

// B1: every spelling a coordinator writes a bundle brief in reaches the script, each at its place
harness("a brief under briefs/, a lane-brief or fix-brief name, a lowercase cc, and a bare CC folder are all checked", async ($, on) => {
  engine(on, "wide", []);
  const runs = script(on, exited(0));
  const spawned = await $.agent.spawn(
    spawnArgs(
      "Read .claude/features/CC-133/briefs/brief-review-data.md, then features/CC-147/lane-brief.md, " +
        "`.claude/features/CC-147/fix-brief.md`, .claude/features/cc-147/brief-low.md, and CC-147/brief-x.md.",
    ),
  );
  expect(spawned.agentId).toBe("new");
  expect(runs.map((run) => run.argv[2])).toEqual([
    "/repo/.claude/features/CC-133/briefs/brief-review-data.md",
    "/repo/.claude/features/CC-147/lane-brief.md",
    "/repo/.claude/features/CC-147/fix-brief.md",
    "/repo/.claude/features/CC-147/brief-low.md",
    "/repo/.claude/features/CC-147/brief-x.md",
  ]);
});

// B12: a brief named with no root to run from is a fail-open on disk, never a silent pass
harness("a session root that rejects fails the brief check open with a brief-unchecked key", async ($, on) => {
  const status: Array<string | undefined> = [];
  const store = new Map<string, unknown>();
  const clock = engine(on, "wide", [], status, {}, store, false, true);
  const runs = script(on, exited(1, BREACH));
  expect((await $.agent.spawn(spawnArgs(BRIEF_PROMPT))).agentId).toBe("new");
  expect(runs).toEqual([]);
  expect(status.at(-1)).toBe(
    "brief-size check found no session root to run from, spawn allowed; pace wide",
  );
  await clock.advance(0);
  expect(store.get("lane-pace.verdict.brief-unchecked")).toEqual({
    session: "s1",
    at: 1_000,
    count: 1,
  });
});

// B13: a ~/ brief resolves from HOME, never under the session root
harness("a ~/ brief path is expanded from HOME before the exists check", async ($, on) => {
  engine(on, "wide", [], [], {}, new Map(), false, false, { HOME: "/home/dave" });
  const runs = script(on, exited(1, BREACH), [
    "/repo/~/work/.claude/features/CC-999/brief-H.md",
  ]);
  const spawned = await $.agent.spawn(
    spawnArgs("Your brief is ~/work/.claude/features/CC-999/brief-H.md."),
  );
  expect(runs.map((run) => run.argv[2])).toEqual([
    "/home/dave/work/.claude/features/CC-999/brief-H.md",
  ]);
  expect(spawned.deny).toContain(BREACH);
});

// B10 and B15: the caps have one home, the script, and the open text names the shared-brief shape
harness("the deny points at the script for the caps and the open text names the shared-brief shape", async ($, on) => {
  engine(on, "wide", []);
  script(on, {
    [BRIEF_PATH]: exited(1, BREACH),
    "/repo/.claude/features/CC-999/brief-B.md": exited(2, "", PARSE),
  });
  const denied = (await $.agent.spawn(spawnArgs(BRIEF_PROMPT))).deny ?? "";
  const tail = denied.slice(BREACH.length);
  expect(tail).toContain(
    "past the brief-size caps .claude/hooks/lib/check-brief-size.sh counts, its header names them",
  );
  expect(tail).not.toMatch(/\bfour\b|\b4\b/);
  const opened =
    (
      await $.agent.spawn(
        spawnArgs("Your brief is .claude/features/CC-999/brief-B.md."),
      )
    ).deny ?? "";
  expect(opened).toContain(
    "One common brief whose lanes each get their owned files in the prompt is that shape: it passes only with the declaration",
  );
});

// a spawn inside a lane, the lane's id as parentAgentId and its model as parentModel. the
// main loop's spawns carry parentModel too, so parentAgentId is what makes one nested
const nested = (
  parentModel: string,
  model?: string,
  subagentType = 'general-purpose',
  over: Partial<AgentSpawnInput> = {},
): AgentSpawnInput => ({
  ...spawnArgs('review the diff', model, subagentType, parentModel),
  parentAgentId: 'lane-1',
  ...over,
})
const AGENT_FILES = {
  '/repo/.claude/agents/code-reviewer.md': '---\nname: code-reviewer\nmodel: opus\n---\nbody',
  '/repo/.claude/agents/docs-engineer.md': '---\nname: docs-engineer\nmodel: sonnet\n---\nbody',
  '/repo/.claude/agents/scout.md': '---\nname: scout\nmodel: haiku\n---\nbody',
  '/repo/.claude/agents/inheritor.md': '---\nname: inheritor\nmodel: inherit\n---\nbody',
  '/repo/.claude/agents/design-critic.md': '---\nname: design-critic\nmodel: fable\n---\nbody',
  '/repo/.claude/agents/plain.md': '---\nname: plain\n---\nbody',
}
const OPUS_PASSES = 'Respawn it with model: "sonnet" or "haiku".'

// parent, the call's model, the agent type, and whether the spawn starts, unchecked a start that
// fails open with the status note. opus-haiku names two tiers and opusplan none by whole word
// built-in is a type with no agent file, its own model unread, so it starts with its own note
const LADDER: Array<[string, string | undefined, string, boolean | 'unchecked' | 'built-in']> = [
  ['opus', 'opus-haiku', 'general-purpose', 'unchecked'],
  ['opus', 'opusplan', 'general-purpose', 'unchecked'],
  ['opus', 'opus', 'general-purpose', false],
  ['opus', undefined, 'plain', false],
  ['opus', undefined, 'general-purpose', 'built-in'],
  ['opus', 'inherit', 'general-purpose', false],
  ['opus', undefined, 'code-reviewer', false],
  ['opus', undefined, 'inheritor', false],
  ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'general-purpose', false],
  ['opus', 'sonnet', 'general-purpose', true],
  ['opus', 'haiku', 'general-purpose', true],
  ['opus', undefined, 'docs-engineer', true],
  ['claude-opus-5-5', 'claude-haiku-5-5', 'general-purpose', true],
  ['sonnet', 'sonnet', 'general-purpose', false],
  ['sonnet', undefined, 'docs-engineer', false],
  ['sonnet', 'opus', 'general-purpose', false],
  ['sonnet', 'haiku', 'general-purpose', true],
  ['sonnet', undefined, 'scout', true],
  ['haiku', 'haiku', 'general-purpose', true],
  ['claude-haiku-5-5', undefined, 'plain', true],
  ['haiku', 'sonnet', 'general-purpose', false],
  ['fable', 'opus', 'general-purpose', true],
  ['fable', 'haiku', 'general-purpose', true],
  ['fable', undefined, 'code-reviewer', true],
  ['fable', 'fable', 'design-critic', false],
]

harness('the ladder table: a nested spawn starts only one tier or more below its parent, haiku to haiku', async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, 'wide', [], status, AGENT_FILES)
  for (const [parent, model, type, verdict] of LADDER) {
    const spawned = await $.agent.spawn(nested(parent, model, type))
    expect([parent, model, type, spawned.agentId === 'new']).toEqual([parent, model, type, verdict !== false])
    if (verdict === false) expect(spawned.deny).toMatch(/model ladder|judgment seat/)
    if (verdict !== false)
      expect([model, status.at(-1)?.startsWith('model ladder unchecked, model ')]).toEqual([model, verdict === 'unchecked'])
    if (verdict === 'built-in')
      expect(status.at(-1)).toBe(`model ladder unchecked, ${type} is a built-in with no agent file, its model unread, spawn allowed; pace wide`)
  }
})

harness('an opus parent refused on a pin names both tiers, the pin, and the two passes, and writes verdict:ladder', async ($, on) => {
  const status: Array<string | undefined> = []
  const store = new Map<string, unknown>()
  const clock = engine(on, 'wide', [], status, AGENT_FILES, store)
  const spawned = await $.agent.spawn(nested('opus', 'opus'))
  expect(spawned.deny).toBe(
    "The model ladder: a lane's own spawn goes one tier down, Haiku to Haiku the one " +
      'same-tier pass. The parent runs opus, and this general-purpose spawn resolves to opus on its ' +
      `model: "opus" pin. ${OPUS_PASSES}`,
  )
  expect(status.at(-1)).toBe('model ladder, spawn refused')
  await clock.advance(0)
  expect(store.get('lane-pace.verdict.ladder')).toEqual({ session: 's1', at: 1_000, count: 1 })
  expect(store.get('lane-pace.verdict.wide')).toBe(undefined)
})

harness('an opus parent refused on inherit and on an agent file each name where the tier came from', async ($, on) => {
  engine(on, 'wide', [], [], AGENT_FILES)
  const bare = (await $.agent.spawn(nested('opus', undefined, 'plain'))).deny
  expect(bare).toContain(
    'resolves to opus inherited from the parent, with no pin given and none in its agent file. ' + OPUS_PASSES,
  )
  const filed = (await $.agent.spawn(nested('claude-opus-5-5', undefined, 'code-reviewer'))).deny
  expect(filed).toContain('The parent runs opus, and this code-reviewer spawn resolves to opus on its agent file')
  expect(filed).toContain("agent file's model: opus. " + OPUS_PASSES)
})

harness('a sonnet parent is told haiku, a haiku parent is told haiku, a fable parent is told all three', async ($, on) => {
  engine(on, 'wide', [], [], AGENT_FILES)
  const sonnet = (await $.agent.spawn(nested('sonnet', undefined, 'docs-engineer'))).deny
  expect(sonnet).toContain("The parent runs sonnet, and this docs-engineer spawn resolves to sonnet on its agent file's")
  expect(sonnet).toMatch(/Respawn it with model: "haiku"\.$/)
  const haiku = (await $.agent.spawn(nested('haiku', 'sonnet'))).deny
  expect(haiku).toContain('The parent runs haiku, and this general-purpose spawn resolves to sonnet')
  expect(haiku).toMatch(/Respawn it with model: "haiku"\.$/)
  // a fable lane's own fable child meets the fable rule first, which hands it the fable tier's passes
  const fable = (await $.agent.spawn(nested('fable'))).deny
  expect(fable).toMatch(/Respawn this general-purpose lane with model: "opus", "sonnet", or "haiku"\.$/)
})

// B1 and X1-1: the plain CLAUDE_CODE_SUBAGENT_MODEL names the model, CLAUDE_CODE_SUBAGENT_MODEL_FORCE
// is a flag on 1, true, or yes that makes it outrank every pin, as the 2.1.300 resolver reads them
const FORCED_TAIL =
  'and the flag outranks every model: pin but "inherit", which runs the parent\'s model. Unset the flag, or run the step inline.'
const forcing = (plain: string) =>
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE, a flag that is on and forces CLAUDE_CODE_SUBAGENT_MODEL "${plain}" on every subagent`

harness('a forced session model is the child for every spawn, and the refusal names the flag and the plain value', async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, 'wide', [], status, AGENT_FILES, new Map(), false, false, {
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
    CLAUDE_CODE_SUBAGENT_MODEL: 'opus',
  })
  const pinned = (await $.agent.spawn(nested('opus', 'haiku'))).deny
  expect(pinned).toBe(
    "The model ladder: a lane's own spawn goes one tier down, Haiku to Haiku the one " +
      `same-tier pass. The parent runs opus, and this general-purpose spawn resolves to opus on ${forcing('opus')}, ` +
      FORCED_TAIL,
  )
  expect((await $.agent.spawn(nested('opus', undefined, 'scout'))).deny).toContain(forcing('opus'))
  // a plugin agent is placed too, its definition never read
  const plugin = await $.agent.spawn(nested('opus', undefined, 'acme:helper', { provider: { plugin: 'acme', tier: 'user' } }))
  expect(plugin.deny).toContain('this acme:helper spawn resolves to opus on CLAUDE_CODE_SUBAGENT_MODEL_FORCE')
  // a fable session's bare built-in runs the forced opus, never fable, and an explicit fable ask runs opus too
  expect((await $.agent.spawn(spawnArgs('review the diff', undefined, 'general-purpose', 'fable'))).agentId).toBe('new')
  expect((await $.agent.spawn(spawnArgs('review the diff', 'fable'))).agentId).toBe('new')
})

harness('a forced haiku lets a nested opus pin and an opus agent file start', async ($, on) => {
  engine(on, 'wide', [], [], AGENT_FILES, new Map(), false, false, {
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: 'true',
    CLAUDE_CODE_SUBAGENT_MODEL: 'haiku',
  })
  expect((await $.agent.spawn(nested('opus', 'opus'))).agentId).toBe('new')
  expect((await $.agent.spawn(nested('opus', undefined, 'code-reviewer'))).agentId).toBe('new')
})

harness('a forced fable refuses a main-loop lane on any pin, naming the flag and the plain value, the critic passing', async ($, on) => {
  engine(on, 'wide', [], [], AGENT_FILES, new Map(), false, false, {
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
    CLAUDE_CODE_SUBAGENT_MODEL: 'fable',
  })
  expect((await $.agent.spawn(spawnArgs('review the diff', 'opus'))).deny).toBe(
    "A Fable pin is for a judgment seat, and design-critic is the only one. " +
      `This general-purpose spawn runs fable on ${forcing('fable')}, ${FORCED_TAIL}`,
  )
  expect((await $.agent.spawn(spawnArgs('critique the shots', undefined, 'design-critic'))).agentId).toBe('new')
})

// X1-1: the flag reads 1, true, or yes in any case
for (const flag of ['TRUE', ' Yes '])
  harness(`the flag is on for "${flag}" as for 1`, async ($, on) => {
    engine(on, 'wide', [], [], AGENT_FILES, new Map(), false, false, {
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: flag,
      CLAUDE_CODE_SUBAGENT_MODEL: 'fable',
    })
    expect((await $.agent.spawn(spawnArgs('review the diff', 'opus'))).deny).toContain(forcing('fable'))
  })

// X1-1: a model name in the flag is no flag, so the call's pin and the plain default decide
harness('a model name in the flag leaves it off, the call pin over the plain default as ever', async ($, on) => {
  engine(on, 'wide', [], [], AGENT_FILES, new Map(), false, false, {
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: 'fable',
    CLAUDE_CODE_SUBAGENT_MODEL: 'opus',
  })
  expect((await $.agent.spawn(spawnArgs('review the diff', 'opus'))).agentId).toBe('new')
  expect((await $.agent.spawn(nested('opus', 'haiku'))).agentId).toBe('new')
  expect((await $.agent.spawn(nested('opus', undefined, 'plain'))).deny).toContain('on CLAUDE_CODE_SUBAGENT_MODEL "opus", the session default')
})

// X1-1: the flag on with the plain variable unset forces the parent's model
harness('the flag on with no plain value forces the parent, so a nested haiku pin runs opus and is refused', async ($, on) => {
  engine(on, 'wide', [], [], AGENT_FILES, new Map(), false, false, { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' })
  expect((await $.agent.spawn(nested('opus', 'haiku'))).deny).toContain(
    'resolves to opus on CLAUDE_CODE_SUBAGENT_MODEL_FORCE, a flag that is on and, with CLAUDE_CODE_SUBAGENT_MODEL ' +
      `unset, forces the parent's model "opus" on every subagent, ${FORCED_TAIL}`,
  )
  // a fable coordinator's lanes all run fable then, whatever they pin
  expect((await $.agent.spawn(spawnArgs('review the diff', 'haiku', 'general-purpose', 'fable'))).deny).toContain(
    'This general-purpose spawn runs fable on CLAUDE_CODE_SUBAGENT_MODEL_FORCE, a flag that is on and, with',
  )
})

// X1-2: the engine keeps a call's inherit under the flag, so a fable parent's child on inherit is fable
harness("a call's inherit runs the parent under the flag, refused as fable on a fable parent and on the ladder", async ($, on) => {
  engine(on, 'wide', [], [], AGENT_FILES, new Map(), false, false, {
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: 'true',
    CLAUDE_CODE_SUBAGENT_MODEL: 'opus',
  })
  expect((await $.agent.spawn(spawnArgs('review the diff', 'inherit', 'general-purpose', 'fable'))).deny).toBe(
    "A Fable pin is for a judgment seat, and design-critic is the only one. " +
      'This general-purpose spawn names model: "inherit", the one pin CLAUDE_CODE_SUBAGENT_MODEL_FORCE lets through, ' +
      'and runs the parent\'s fable. Respawn it with no model, and the flag runs CLAUDE_CODE_SUBAGENT_MODEL "opus" instead.',
  )
  expect((await $.agent.spawn(spawnArgs('review the diff', undefined, 'general-purpose', 'fable'))).agentId).toBe('new')
  expect((await $.agent.spawn(nested('sonnet', 'inherit'))).deny).toContain(
    'resolves to sonnet on its model: "inherit" pin, which runs the parent\'s model and is the one pin ' +
      'CLAUDE_CODE_SUBAGENT_MODEL_FORCE lets through. Respawn it with no model, and the flag runs ' +
      'CLAUDE_CODE_SUBAGENT_MODEL "opus" instead.',
  )
})

// X1-3: a plain value of inherit is the parent to the engine, never a model of no tier
harness('a plain CLAUDE_CODE_SUBAGENT_MODEL of inherit reads as the parent, so a fable bare built-in is refused', async ($, on) => {
  engine(on, 'wide', [], [], AGENT_FILES, new Map(), false, false, { CLAUDE_CODE_SUBAGENT_MODEL: 'inherit' })
  expect((await $.agent.spawn(spawnArgs('review the diff', undefined, 'general-purpose', 'fable'))).deny).toMatch(
    /design-critic is the only one/,
  )
  expect((await $.agent.spawn(nested('opus', undefined, 'plain'))).deny).toContain(
    'resolves to opus inherited from the parent, with no pin given and none in its agent file. ' + OPUS_PASSES,
  )
})

harness('the plain session model sits under the call pin and the agent file pin and over inherit', async ($, on) => {
  engine(on, 'wide', [], [], AGENT_FILES, new Map(), false, false, { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' })
  // a fable session's bare built-in runs the plain opus, so it is no fable lane
  expect((await $.agent.spawn(spawnArgs('review the diff', undefined, 'general-purpose', 'fable'))).agentId).toBe('new')
  // an agent file on inherit still runs the parent's fable
  expect((await $.agent.spawn(spawnArgs('look', undefined, 'inheritor', 'fable'))).deny).toMatch(/design-critic is the only one/)
  expect((await $.agent.spawn(nested('opus', undefined, 'plain'))).deny).toContain(
    'resolves to opus on CLAUDE_CODE_SUBAGENT_MODEL "opus", the session default under no pin and none in its agent file. ' +
      OPUS_PASSES,
  )
  expect((await $.agent.spawn(nested('opus', 'haiku'))).agentId).toBe('new')
  expect((await $.agent.spawn(nested('opus', undefined, 'docs-engineer'))).agentId).toBe('new')
})

harness('a plain haiku session model lets a bare nested spawn start, and loses to a pin, an agent file, and inherit', async ($, on) => {
  engine(on, 'wide', [], [], AGENT_FILES, new Map(), false, false, { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' })
  expect((await $.agent.spawn(nested('opus'))).agentId).toBe('new')
  expect((await $.agent.spawn(nested('opus', 'opus'))).deny).toContain('on its model: "opus" pin')
  expect((await $.agent.spawn(nested('opus', undefined, 'code-reviewer'))).deny).toContain("on its agent file's model: opus")
  expect((await $.agent.spawn(nested('opus', 'inherit'))).deny).toContain('on its model: "inherit" pin')
  expect((await $.agent.spawn(nested('opus', undefined, 'inheritor'))).deny).toContain("on its agent file's model: inherit")
})

// B2: the respawn a nested fable deny advises has to clear the ladder it meets next
harness('a fable deny inside a lane names the parent tier passes, the main loop keeps opus', async ($, on) => {
  engine(on, 'wide', [], [], AGENT_FILES)
  expect((await $.agent.spawn(nested('opus', 'fable'))).deny).toBe(
    "A Fable pin is for a judgment seat, and design-critic is the only one. " +
      'Respawn this general-purpose lane with model: "sonnet" or "haiku".',
  )
  expect((await $.agent.spawn(nested('claude-sonnet-5-5', 'fable', 'Explore'))).deny).toMatch(
    /Respawn this Explore lane with model: "haiku"\.$/,
  )
  expect((await $.agent.spawn(nested('gpt-9', 'fable'))).deny).toMatch(/Respawn this general-purpose lane with model: "opus"\.$/)
  expect((await $.agent.spawn(spawnArgs('review the diff', 'fable'))).deny).toMatch(
    /Respawn this general-purpose lane with model: "opus"\.$/,
  )
})

// B3: an inherit named in the call or the agent file is its own source, never the bare inherit
harness('an inherit pin and an agent file on inherit each name their own source', async ($, on) => {
  engine(on, 'wide', [], [], AGENT_FILES)
  expect((await $.agent.spawn(nested('opus', 'inherit'))).deny).toContain(
    `this general-purpose spawn resolves to opus on its model: "inherit" pin, which runs the parent's model. ${OPUS_PASSES}`,
  )
  expect((await $.agent.spawn(nested('opus', undefined, 'inheritor'))).deny).toContain(
    `this inheritor spawn resolves to opus on its agent file's model: inherit, which runs the parent's model. ${OPUS_PASSES}`,
  )
})

// B5: the one judgment seat is spawned from the main loop, so a lane is never told a cheaper pin for it
harness('design-critic inside a lane is refused as the main loop seat with no pin advice', async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, 'wide', [], status, AGENT_FILES)
  const seat =
    'design-critic is the one Fable judgment seat, spawned from the main loop and ' +
    'never inside a lane. Report back and let the main loop spawn it.'
  expect((await $.agent.spawn(nested('opus', undefined, 'design-critic'))).deny).toBe(seat)
  expect((await $.agent.spawn(nested('fable', 'fable', 'design-critic'))).deny).toBe(seat)
  expect(status.at(-1)).toBe('model ladder, spawn refused')
  expect((await $.agent.spawn(spawnArgs('critique the shots', undefined, 'design-critic'))).agentId).toBe('new')
})

harness('a fork inside a lane cannot step down and is refused with that said, a haiku lane forks', async ($, on) => {
  const store = new Map<string, unknown>()
  const clock = engine(on, 'wide', [], [], {}, store)
  const forked = await $.agent.spawn(nested('opus', 'haiku', 'fork', { fork: true }))
  expect(forked.deny).toContain(
    "The parent runs opus, and a fork always runs its parent's model, so it cannot step down and is refused. " +
      'Spawn a named agent with model: "sonnet" or "haiku" instead of the fork.',
  )
  expect((await $.agent.spawn(nested('haiku', undefined, 'fork', { fork: true }))).agentId).toBe('new')
  await clock.advance(0)
  expect(store.get('lane-pace.verdict.ladder')).toEqual({ session: 's1', at: 1_000, count: 1 })
})

harness('a plugin agent inside a lane fails the ladder open with a status note', async ($, on) => {
  const status: Array<string | undefined> = []
  const store = new Map<string, unknown>()
  const clock = engine(on, 'wide', [], status, {}, store)
  const spawned = await $.agent.spawn(
    nested('opus', 'opus', 'acme:helper', { provider: { plugin: 'acme', tier: 'user' } }),
  )
  expect(spawned.agentId).toBe('new')
  expect(status.at(-1)).toBe(
    'model ladder unchecked, acme:helper is a plugin agent whose model this cannot read, spawn allowed; pace wide',
  )
  await clock.advance(0)
  expect(store.get('lane-pace.verdict.ladder')).toBe(undefined)
  expect(store.get('lane-pace.verdict.wide')).toEqual({ session: 's1', at: 1_000, count: 1 })
})

harness('a model or parent naming no known tier fails the ladder open with a status note', async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, 'quiet', [], status)
  expect((await $.agent.spawn(nested('opus', 'gpt-9'))).agentId).toBe('new')
  expect(status.at(-1)).toBe(
    'model ladder unchecked, model "gpt-9" names no known tier, spawn allowed; pace quiet, 1 of 2 lanes',
  )
  expect((await $.agent.spawn(nested('best', 'opus'))).agentId).toBe('new')
  expect(status.at(-1)).toBe(
    'model ladder unchecked, parent model "best" names no known tier, spawn allowed; pace quiet, 1 of 2 lanes',
  )
})

harness('a main-session spawn carries no parentAgentId and the ladder never judges it, the same spawn nested is', async ($, on) => {
  const status: Array<string | undefined> = []
  const store = new Map<string, unknown>()
  const clock = engine(on, 'wide', [], status, AGENT_FILES, store)
  expect((await $.agent.spawn(spawnArgs('review the diff', 'opus'))).agentId).toBe('new')
  expect((await $.agent.spawn(spawnArgs('review the diff', undefined, 'code-reviewer'))).agentId).toBe('new')
  expect(status.at(-1)).toBe('pace wide')
  await clock.advance(0)
  expect(store.get('lane-pace.verdict.ladder')).toBe(undefined)
  expect((await $.agent.spawn(nested('opus', 'opus'))).deny).toMatch(/model ladder/)
})

harness('the fable rule runs before the ladder, and a ladder refusal runs no brief script', async ($, on) => {
  const store = new Map<string, unknown>()
  const clock = engine(on, 'wide', [], [], {}, store)
  const runs = script(on, exited(1, BREACH))
  expect((await $.agent.spawn(nested('fable'))).deny).toMatch(/design-critic is the only one/)
  const laddered = await $.agent.spawn({ ...nested('opus', 'opus'), prompt: BRIEF_PROMPT })
  expect(laddered.deny).toMatch(/model ladder/)
  expect(runs).toEqual([])
  await clock.advance(0)
  expect(store.get('lane-pace.verdict.fable')).toEqual({ session: 's1', at: 1_000, count: 1 })
  expect(store.get('lane-pace.verdict.ladder')).toEqual({ session: 's1', at: 1_000, count: 1 })
})

// a SendMessage wake, raised since 2.1.300 as agent.spawn with resume.agentId
const wake = (agentId: string, over: Partial<AgentSpawnInput> = {}): AgentSpawnInput => ({
  ...spawnArgs('carry on'),
  resume: { agentId },
  ...over,
})

harness('a resume skips the fable, ladder, and brief checks and writes verdict:resume beside its pace key', async ($, on) => {
  const store = new Map<string, unknown>()
  const clock = engine(on, 'wide', [], [], {}, store)
  const runs = script(on, exited(1, BREACH))
  expect((await $.agent.spawn(wake('w', { model: 'fable' }))).agentId).toBe('new')
  expect((await $.agent.spawn(wake('w', { model: 'opus', parentAgentId: 'lane-1' }))).agentId).toBe('new')
  expect((await $.agent.spawn(wake('w', { prompt: BRIEF_PROMPT }))).agentId).toBe('new')
  expect(runs).toEqual([])
  await clock.advance(0)
  expect(store.get('lane-pace.verdict.resume')).toEqual({ session: 's1', at: 1_000, count: 3 })
  expect(store.get('lane-pace.verdict.wide')).toEqual({ session: 's1', at: 1_000, count: 3 })
  expect(store.get('lane-pace.verdict.fable')).toBe(undefined)
  expect(store.get('lane-pace.verdict.ladder')).toBe(undefined)
  expect(store.get('lane-pace.verdict.brief')).toBe(undefined)
})

harness('a resume under quiet leaves its own slot out of the live count', async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, 'quiet', [lane('a', 'running'), lane('w', 'running')], status)
  expect((await $.agent.spawn(wake('w'))).agentId).toBe('new')
  expect(status.at(-1)).toBe('pace quiet, 2 of 2 lanes')
  expect((await $.agent.spawn(spawnArgs('review the diff'))).deny).toMatch(/the cap is 2/)
})

harness('a resume past the cap is refused, the refusal saying its own slot is out of the count', async ($, on) => {
  const store = new Map<string, unknown>()
  const clock = engine(on, 'quiet', [lane('a', 'running'), lane('b', 'waiting'), lane('w', 'running')], [], {}, store)
  const spawned = await $.agent.spawn(wake('w'))
  expect(spawned.deny).toMatch(/pace is quiet and 2 lanes are live, the cap is 2/)
  expect(spawned.deny).toContain('This wakes w, whose own slot is left out of the count.')
  expect(spawned.deny).not.toContain('lane w')
  await clock.advance(0)
  expect(store.get('lane-pace.verdict.resume')).toEqual({ session: 's1', at: 1_000, count: 1 })
  expect(store.get('lane-pace.verdict.cap')).toEqual({ session: 's1', at: 1_000, count: 1 })
})

// every status the engine declares, pinned live or not. a build that adds one reds tsc here
const COUNTS: Record<AgentInfo['status'], boolean> = {
  pending: true,
  running: true,
  waiting: true,
  idle: false,
  completed: false,
  failed: false,
  killed: false,
}

harness('every engine status is spawned against, and the cap refusal names each live lane by its status', async ($, on) => {
  const agents: AgentInfo[] = []
  engine(on, 'quiet', agents)
  for (const [status, live] of Object.entries(COUNTS) as Array<[AgentInfo['status'], boolean]>) {
    agents.splice(0, agents.length, lane('a', status), lane('b', status))
    const spawned = await $.agent.spawn(spawnArgs('review the diff'))
    expect([status, spawned.agentId === undefined]).toEqual([status, live])
    if (live)
      expect(spawned.deny).toContain(`general-purpose a "lane a" is ${status}; general-purpose b "lane b" is ${status}.`)
  }
})

// every userConfig option, once on its default and once set, so the default stays this repo's
// shape and the option reaches the guard
// the set case runs on the harness options under the one set, base seeds the default case when
// the option only shows with another on
const option = (
  name: string,
  set: Record<string, string | number | boolean>,
  onDefault: Body,
  onSet: Body,
  base: Record<string, string | number | boolean> = {},
) => {
  test(`option ${name}: default`, { options: base }, onDefault as never)
  test(`option ${name}: set`, { options: { ...HARNESS, ...set } }, onSet as never)
}

option(
  'paceFile',
  { paceFile: 'ops/pace.txt' },
  async ($, on) => {
    engine(on, 'wide', [lane('a', 'running'), lane('b', 'running')])
    expect((await $.agent.spawn(spawnArgs('review the diff'))).agentId).toBe('new')
  },
  async ($, on) => {
    // the default file says wide and is ignored, the configured one says quiet
    engine(on, 'wide', [lane('a', 'running'), lane('b', 'running')], [], { '/repo/ops/pace.txt': 'quiet' })
    expect((await $.agent.spawn(spawnArgs('review the diff'))).deny).toMatch(/the cap is 2/)
  },
)

option(
  'quietCap',
  { quietCap: 4 },
  async ($, on) => {
    engine(on, 'quiet', [lane('a', 'running'), lane('b', 'running')])
    expect((await $.agent.spawn(spawnArgs('review the diff'))).deny).toMatch(/the cap is 2/)
  },
  async ($, on) => {
    const status: Array<string | undefined> = []
    engine(on, 'quiet', [lane('a', 'running'), lane('b', 'running'), lane('c', 'running')], status)
    expect((await $.agent.spawn(spawnArgs('review the diff'))).agentId).toBe('new')
    expect(status.at(-1)).toBe('pace quiet, 4 of 4 lanes')
  },
)

// the refusal names the pace file it reads, so the lift is always one the repo can do
test('the cap refusal names the configured pace file as the lift', { options: { paceFile: 'ops/pace.txt' } }, async ($, on) => {
  engine(on, undefined, [lane('a', 'running'), lane('b', 'running')], [], { '/repo/ops/pace.txt': 'quiet' })
  const deny = (await $.agent.spawn(spawnArgs('review the diff'))).deny ?? ''
  expect(deny).toMatch(/run the step inline; write wide to ops\/pace\.txt to lift the cap\.$/)
  expect(deny).not.toContain('pace.sh')
})

test('option quietCap: zero is a cap of zero, every spawn refused under quiet', { options: { quietCap: 0 } }, async ($, on) => {
  engine(on, 'quiet', [])
  expect((await $.agent.spawn(spawnArgs('review the diff'))).deny).toMatch(/0 lanes are live, the cap is 0/)
})

// the paces map: each word its own cap, wide never capped, quiet at quietCap unless a pair names it
const TIERS = { paces: 'calm=1 quiet=2 busy=4' }

option(
  'paces',
  TIERS,
  async ($, on) => {
    // no map, so busy is a word nothing names and reads quiet's cap
    engine(on, 'busy', [lane('a', 'running'), lane('b', 'running')])
    expect((await $.agent.spawn(spawnArgs('review the diff'))).deny).toMatch(/pace is quiet and 2 lanes are live, the cap is 2/)
  },
  async ($, on) => {
    engine(on, 'busy', [lane('a', 'running'), lane('b', 'running')])
    expect((await $.agent.spawn(spawnArgs('review the diff'))).agentId).toBe('new')
  },
)

test('option paces: a two-tier map caps each word at its own number', { options: TIERS }, async ($, on) => {
  const agents = [lane('a', 'running')]
  const files: Record<string, string> = {}
  engine(on, undefined, agents, [], files)
  const at = async (word: string) => {
    files['/repo/.claude/state/pace'] = `${word}\n`
    return $.agent.spawn(spawnArgs('review the diff'))
  }
  expect((await at('calm')).deny).toMatch(/the cap is 1/)
  expect((await at('quiet')).agentId).toBe('new')
  agents.push(lane('b', 'running'), lane('c', 'running'))
  expect((await at('quiet')).deny).toMatch(/the cap is 2/)
  expect((await at('busy')).agentId).toBe('new')
  agents.push(lane('d', 'running'))
  expect((await at('busy')).deny).toMatch(/the cap is 4/)
})

test('option paces: a word the map does not name reads its smallest cap', { options: { paces: 'quiet=3 calm=1 busy=5' } }, async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, 'Wide', [lane('a', 'running')], status)
  const deny = (await $.agent.spawn(spawnArgs('review the diff'))).deny ?? ''
  expect(deny).toMatch(/^pace is calm and 1 lanes are live, the cap is 1/)
  expect(status.at(-1)).toBe('pace calm, 1 of 1 lanes, spawn refused')
})

test(
  'option paces: a wide pair is dropped and wide stays uncapped',
  { options: { paces: 'wide=3 quiet=1 junk calm=x =2 big=2.5' } },
  async ($, on) => {
    const agents = [lane('a', 'running'), lane('b', 'running'), lane('c', 'running')]
    const files: Record<string, string> = { '/repo/.claude/state/pace': 'wide' }
    engine(on, undefined, agents, [], files)
    expect((await $.agent.spawn(spawnArgs('review the diff'))).agentId).toBe('new')
    // every pair but quiet=1 is malformed, so big reads the one cap left
    files['/repo/.claude/state/pace'] = 'big'
    expect((await $.agent.spawn(spawnArgs('review the diff'))).deny).toMatch(/^pace is quiet and 3 lanes are live, the cap is 1/)
  },
)

test('option paces: empty keeps quietCap as the cap of quiet', { options: { paces: '', quietCap: 3 } }, async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, 'quiet', [lane('a', 'running'), lane('b', 'running')], status)
  expect((await $.agent.spawn(spawnArgs('review the diff'))).agentId).toBe('new')
  expect(status.at(-1)).toBe('pace quiet, 3 of 3 lanes')
})

test('option paces: a map that skips quiet leaves quiet at quietCap', { options: { paces: 'busy=6', quietCap: 1 } }, async ($, on) => {
  engine(on, 'quiet', [lane('a', 'running')])
  expect((await $.agent.spawn(spawnArgs('review the diff'))).deny).toMatch(/pace is quiet and 1 lanes are live, the cap is 1/)
})

test('option paces: the status and the refusal name the word, the lift a higher word or wide', { options: TIERS }, async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, 'calm', [lane('a', 'running')], status)
  const deny = (await $.agent.spawn(spawnArgs('review the diff'))).deny ?? ''
  expect(deny).toMatch(/^pace is calm and 1 lanes are live, the cap is 1:/)
  expect(deny).toMatch(/run the step inline; write quiet, busy, or wide to \.claude\/state\/pace to lift the cap\.$/)
  expect(status.at(-1)).toBe('pace calm, 1 of 1 lanes, spawn refused')
  await $.turn.complete(mainTurn())
  expect(status.at(-1)).toBe('pace calm, 1 of 1 lanes')
})

// a stranger's install: the shipped defaults, nothing on disk but what each case names
test('defaults: a main-loop Explore spawn in a fable session starts, the seat rule off', async ($, on) => {
  engine(on, undefined, [])
  expect((await $.agent.spawn(spawnArgs('look around', undefined, 'Explore', 'claude-fable-5'))).agentId).toBe('new')
})

test('defaults: with no pace file a third lane starts, since missing reads wide', async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, undefined, [lane('a', 'running'), lane('b', 'running')], status)
  expect((await $.agent.spawn(spawnArgs('review the diff'))).agentId).toBe('new')
  expect(status.at(-1)).toBe('pace wide')
})

test('defaults: a nested spawn at its parent tier starts and a named brief runs no script', async ($, on) => {
  engine(on, undefined, [])
  const runs = script(on, exited(1, `${BREACH}\n`))
  expect((await $.agent.spawn(nested('opus', 'opus'))).agentId).toBe('new')
  expect((await $.agent.spawn(spawnArgs(BRIEF_PROMPT))).agentId).toBe('new')
  expect(runs).toEqual([])
})

harness('a user-scope agent pinned haiku is read from ~/.claude/agents and starts under an opus lane', async ($, on) => {
  engine(on, 'wide', [], [], { '/home/u/.claude/agents/scout2.md': '---\nname: scout2\nmodel: haiku\n---\n' }, new Map(), false, false, {
    HOME: '/home/u',
  })
  expect((await $.agent.spawn(nested('opus', undefined, 'scout2', { provider: { plugin: 'engine', tier: 'user' } as never }))).agentId).toBe('new')
})

harness('a project agent file outranks a user-scope one of the same name', async ($, on) => {
  engine(on, 'wide', [], [], { ...AGENT_FILES, '/home/u/.claude/agents/code-reviewer.md': '---\nmodel: haiku\n---\n' }, new Map(), false, false, {
    HOME: '/home/u',
  })
  expect((await $.agent.spawn(nested('opus', undefined, 'code-reviewer'))).deny).toContain("on its agent file's model: opus")
})

test('option seatModel: haiku is no seat and falls back to fable', { options: { ...HARNESS, seatModel: 'haiku' } }, async ($, on) => {
  engine(on, 'wide', [])
  expect((await $.agent.spawn(spawnArgs('review the diff', 'haiku'))).agentId).toBe('new')
  expect((await $.agent.spawn(spawnArgs('review the diff', 'fable'))).deny).toMatch(/A Fable pin is for a judgment seat/)
})

option(
  'seatAgent',
  { seatAgent: 'architect' },
  async ($, on) => {
    // empty, so the seat rule is off and any type runs on fable
    engine(on, 'wide', [])
    expect((await $.agent.spawn(spawnArgs('judge', 'fable', 'design-critic'))).agentId).toBe('new')
    expect((await $.agent.spawn(spawnArgs('judge', 'fable', 'architect'))).agentId).toBe('new')
    expect((await $.agent.spawn(spawnArgs('look', undefined, 'Explore', 'claude-fable-5'))).agentId).toBe('new')
  },
  async ($, on) => {
    engine(on, 'wide', [])
    expect((await $.agent.spawn(spawnArgs('judge', 'fable', 'architect'))).agentId).toBe('new')
    expect((await $.agent.spawn(spawnArgs('judge', 'fable', 'design-critic'))).deny).toMatch(/architect is the only one/)
  },
)

option(
  'seatModel',
  { seatModel: 'opus' },
  async ($, on) => {
    engine(on, 'wide', [])
    expect((await $.agent.spawn(spawnArgs('review the diff', 'opus'))).agentId).toBe('new')
  },
  async ($, on) => {
    const status: Array<string | undefined> = []
    engine(on, 'wide', [], status)
    const spawned = await $.agent.spawn(spawnArgs('review the diff', 'claude-opus-5-5'))
    expect(spawned.deny).toBe(
      'An Opus pin is for a judgment seat, and design-critic is the only one. ' +
        'Respawn this general-purpose lane with model: "sonnet".',
    )
    expect(status.at(-1)).toBe('opus subagent refused')
    expect((await $.agent.spawn(spawnArgs('review the diff', 'opus', 'design-critic'))).agentId).toBe('new')
  },
)

option(
  'agentsDir',
  { agentsDir: 'agents/' },
  async ($, on) => {
    engine(on, 'wide', [], [], { '/repo/.claude/agents/pinned.md': '---\nmodel: opus\n---\n' })
    expect((await $.agent.spawn(spawnArgs('go', undefined, 'pinned', 'fable'))).agentId).toBe('new')
  },
  async ($, on) => {
    engine(on, 'wide', [], [], {
      '/repo/.claude/agents/pinned.md': '---\nmodel: opus\n---\n',
      '/repo/agents/moved.md': '---\nmodel: opus\n---\n',
    })
    expect((await $.agent.spawn(spawnArgs('go', undefined, 'pinned', 'fable'))).deny).toMatch(/only one/)
    expect((await $.agent.spawn(spawnArgs('go', undefined, 'moved', 'fable'))).agentId).toBe('new')
  },
)

option(
  'ladder',
  { ladder: true },
  async ($, on) => {
    // off by default, so a nested spawn at its parent's tier starts
    engine(on, 'wide', [])
    expect((await $.agent.spawn(nested('opus', 'opus'))).agentId).toBe('new')
    expect((await $.agent.spawn(nested('haiku', 'sonnet'))).agentId).toBe('new')
  },
  async ($, on) => {
    engine(on, 'wide', [])
    expect((await $.agent.spawn(nested('opus', 'opus'))).deny).toMatch(/^The model ladder/)
  },
)

option(
  'briefScript',
  { briefScript: '.claude/hooks/lib/check-brief-size.sh' },
  async ($, on) => {
    // empty, so a named brief runs no script
    engine(on, 'wide', [])
    const runs = script(on, exited(1, `${BREACH}\n`))
    expect((await $.agent.spawn(spawnArgs(BRIEF_PROMPT))).agentId).toBe('new')
    expect(runs).toEqual([])
  },
  async ($, on) => {
    engine(on, 'wide', [])
    const runs = script(on, exited(1, `${BREACH}\n`))
    expect((await $.agent.spawn(spawnArgs(BRIEF_PROMPT))).deny).toContain(BREACH)
    expect(runs[0]?.argv[1]).toBe('/repo/.claude/hooks/lib/check-brief-size.sh')
  },
)

test('option briefScript: a path set elsewhere is the one run', { options: { briefScript: '/opt/size.sh' } }, async ($, on) => {
  engine(on, 'wide', [])
  const runs = script(on, exited(0))
  expect((await $.agent.spawn(spawnArgs(BRIEF_PROMPT))).agentId).toBe('new')
  expect(runs.map(r => r.argv)).toEqual([['bash', '/opt/size.sh', BRIEF_PATH]])
})

option(
  'briefTimeoutMs',
  { briefTimeoutMs: 2500 },
  async ($, on) => {
    engine(on, 'wide', [])
    const runs = script(on, exited(0))
    await $.agent.spawn(spawnArgs(BRIEF_PROMPT))
    expect(runs[0]?.timeoutMs).toBe(10_000)
  },
  async ($, on) => {
    engine(on, 'wide', [])
    const runs = script(on, exited(0))
    await $.agent.spawn(spawnArgs(BRIEF_PROMPT))
    expect(runs[0]?.timeoutMs).toBe(2500)
  },
  { briefScript: HARNESS.briefScript },
)

option(
  'bundleDir',
  { bundleDir: 'work/bundles' },
  async ($, on) => {
    engine(on, 'wide', [])
    const runs = script(on, exited(0))
    await $.agent.spawn(spawnArgs('read features/CC-9/brief-A.md and CC-9/brief-B.md'))
    expect(runs.map(r => r.argv[2])).toEqual([
      '/repo/.claude/features/CC-9/brief-A.md',
      '/repo/.claude/features/CC-9/brief-B.md',
    ])
  },
  async ($, on) => {
    engine(on, 'wide', [])
    const runs = script(on, exited(0))
    await $.agent.spawn(spawnArgs('read bundles/CC-9/brief-A.md and CC-9/brief-B.md'))
    expect(runs.map(r => r.argv[2])).toEqual(['/repo/work/bundles/CC-9/brief-A.md', '/repo/work/bundles/CC-9/brief-B.md'])
  },
  { briefScript: HARNESS.briefScript },
)

option(
  'bundlePrefix',
  { bundlePrefix: 'TKT' },
  async ($, on) => {
    engine(on, 'wide', [])
    const runs = script(on, exited(0))
    await $.agent.spawn(spawnArgs('read cc-9/brief-A.md and TKT-9/brief-B.md'))
    expect(runs.map(r => r.argv[2])).toEqual(['/repo/.claude/features/CC-9/brief-A.md'])
  },
  async ($, on) => {
    engine(on, 'wide', [])
    const runs = script(on, exited(0))
    await $.agent.spawn(spawnArgs('read cc-9/brief-A.md and tkt-9/briefs/brief-B.md'))
    expect(runs.map(r => r.argv[2])).toEqual(['/repo/.claude/features/TKT-9/briefs/brief-B.md'])
  },
  { briefScript: HARNESS.briefScript },
)

option(
  'briefPattern',
  { briefPattern: 'docs/briefs/[\\w-]+\\.md' },
  async ($, on) => {
    engine(on, 'wide', [])
    const runs = script(on, exited(0))
    await $.agent.spawn(spawnArgs('read docs/briefs/lane-a.md and CC-9/brief-B.md'))
    expect(runs.map(r => r.argv[2])).toEqual(['/repo/.claude/features/CC-9/brief-B.md'])
  },
  async ($, on) => {
    engine(on, 'wide', [])
    const runs = script(on, exited(0))
    await $.agent.spawn(spawnArgs('read docs/briefs/lane-a.md and CC-9/brief-B.md'))
    expect(runs.map(r => r.argv[2])).toEqual(['/repo/docs/briefs/lane-a.md'])
  },
  { briefScript: HARNESS.briefScript },
)

// the project and local settings files as the engine loads them, each answered by its source, and
// every source asked for in order, so a case can count the reads
const settings = (on: On, project: Record<string, unknown>, local: Record<string, unknown> = {}) => {
  const reads: string[] = []
  on('settings.read', (_, e) => {
    reads.push(String(e.source))
    return { value: e.source === 'project' ? project : e.source === 'local' ? local : {} }
  })
  return reads
}
const blockOf = (entries: Record<string, Record<string, unknown>>) => ({
  pluginConfigs: Object.fromEntries(Object.entries(entries).map(([key, options]) => [key, { options }])),
})

test(
  'a project block field wins over the user value, local over project',
  { options: { ...HARNESS, quietCap: 1, seatAgent: 'architect' } },
  async ($, on) => {
    const status: Array<string | undefined> = []
    const agents = [lane('a', 'running')]
    engine(on, 'quiet', agents, status)
    const reads = settings(
      on,
      // a lookalike name is no match, and the first lane-pace entry in file order is the one taken
      blockOf({
        'lane-pacer@claude-lanes': { quietCap: 9 },
        'lane-pace@claude-lanes': { quietCap: 3, seatAgent: 'design-critic' },
        'lane-pace@elsewhere': { seatAgent: 'other' },
      }),
      blockOf({ 'lane-pace@inline': { quietCap: 2 } }),
    )
    // a turn end that comes first still meets the merged block
    await $.turn.complete(mainTurn())
    expect(status.at(-1)).toBe('pace quiet, 1 of 2 lanes')
    expect((await $.agent.spawn(spawnArgs('review the diff'))).agentId).toBe('new')
    agents.push(lane('b', 'running'))
    expect((await $.agent.spawn(spawnArgs('review the diff'))).deny).toMatch(/the cap is 2/)
    expect((await $.agent.spawn(spawnArgs('judge', 'fable', 'architect'))).deny).toMatch(/design-critic is the only one/)
    // read once for the session, the project file then the local one
    expect(reads).toEqual(['project', 'local'])
  },
)

test(
  'a wrong-typed project field is ignored and the user value stands',
  { options: { ...HARNESS, quietCap: 3, seatModel: 'opus' } },
  async ($, on) => {
    const status: Array<string | undefined> = []
    engine(on, 'quiet', [lane('a', 'running'), lane('b', 'running')], status, AGENT_FILES)
    settings(
      on,
      blockOf({
        'lane-pace@claude-lanes': { quietCap: '1', ladder: 'false', seatModel: 'haiku', seatAgent: 'architect' },
      }),
    )
    // the string cap and the string ladder are dropped, the right-typed seat agent beside them wins.
    // sonnet, since a bare built-in under this opus parent would meet the opus seat first
    expect((await $.agent.spawn(spawnArgs('review the diff', 'sonnet'))).agentId).toBe('new')
    expect(status.at(-1)).toBe('pace quiet, 3 of 3 lanes')
    expect((await $.agent.spawn(nested('sonnet', 'sonnet'))).deny).toMatch(/^The model ladder/)
    // a seat model outside the manifest's options counts as unset, so the user's opus stands
    expect((await $.agent.spawn(spawnArgs('review the diff', 'opus'))).deny).toMatch(
      /^An Opus pin is for a judgment seat, and architect is the only one\./,
    )
  },
)

test('no project block changes nothing', { options: { ...HARNESS, quietCap: 4 } }, async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, 'quiet', [lane('a', 'running'), lane('b', 'running'), lane('c', 'running')], status)
  // another mod's block, a first lane-pace entry that is no object, and a block with no options
  settings(on, { pluginConfigs: { 'lane-fence@claude-lanes': { options: { quietCap: 1 } }, 'lane-pace@x': 'quiet' } }, {
    pluginConfigs: { 'lane-pace@claude-lanes': {} },
  })
  expect((await $.agent.spawn(spawnArgs('review the diff'))).agentId).toBe('new')
  expect(status.at(-1)).toBe('pace quiet, 4 of 4 lanes')
  expect((await $.agent.spawn(spawnArgs('review the diff', 'fable'))).deny).toMatch(/design-critic is the only one/)
})

test('a settings read that rejects leaves the user options standing', { options: { ...HARNESS, quietCap: 4 } }, async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, 'quiet', [lane('a', 'running'), lane('b', 'running'), lane('c', 'running')], status)
  on('settings.read', () => ({ deny: 'settings unavailable' }))
  expect((await $.agent.spawn(spawnArgs('review the diff'))).agentId).toBe('new')
  expect(status.at(-1)).toBe('pace quiet, 4 of 4 lanes')
  await $.turn.complete(mainTurn())
  expect(status.at(-1)).toBe('pace quiet, 3 of 4 lanes')
})

// a nested seat refusal offers the passes below both the parent and the seat, never the model refused
for (const [seat, parent, told] of [
  ['opus', 'fable', 'model: "sonnet" or "haiku"'],
  ['sonnet', 'opus', 'model: "haiku"'],
] as const)
  test(
    `a nested refusal on the ${seat} seat never offers ${seat} back, the parent on ${parent}`,
    { options: { ...HARNESS, seatModel: seat } },
    async ($, on) => {
      engine(on, 'wide', [], [], AGENT_FILES)
      expect((await $.agent.spawn(nested(parent, seat))).deny).toBe(
        `${seat === 'opus' ? 'An' : 'A'} ${seat === 'opus' ? 'Opus' : 'Sonnet'} pin is for a judgment seat, and ` +
          `design-critic is the only one. Respawn this general-purpose lane with ${told}.`,
      )
    },
  )
