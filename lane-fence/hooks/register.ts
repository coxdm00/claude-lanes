import type { PluginOptions, Register } from "claude-code";

// every repo-specific value is a userConfig option, the defaults in plugin.json match these
export const DEFAULTS = {
  // no type is fenced until one is named
  agentTypes: "",
  recordFolders: ".claude/reviews/",
  memoryRoot: ".claude/agent-memory",
  worktreesDir: ".claude/worktrees",
  rootTmp: "tmp",
  systemTmp: "/tmp",
  statDeadlineMs: 2000,
} as const;

// a list option arrives as a comma string, or an array where the host stores one
const listOf = (value: unknown, fallback: string) =>
  (Array.isArray(value)
    ? value.map(String)
    : typeof value === "string"
      ? value.split(",")
      : fallback.split(",")
  )
    .map((item) => item.trim())
    .filter((item) => item !== "");
const textOf = (value: unknown, fallback: string) =>
  typeof value === "string" ? value.trim() : fallback;
const trimSlashes = (path: string) =>
  path.replace(/^\.?\/+/, "").replace(/\/+$/, "");

// the record paths: each record folder pattern, the agent's OWN memory dir, never a sibling's, and
// the tmp dirs. every arm compares where a write lands, so root and tmp are placed the same way
type Where = { type: string; root: string; tmp: string };
type Who = Pick<Where, "type">;
type Allow = {
  record: (w: Who) => string;
  holds: (path: string, w: Where) => boolean;
};
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// a * in a record pattern is one or more characters inside one path segment
const globRe = (pattern: string) =>
  trimSlashes(pattern).split("*").map(esc).join("[^/]+");

export type FenceConfig = {
  types: ReadonlySet<string>;
  allow: readonly Allow[];
  systemTmp: string | undefined;
  deadlineMs: number;
};

// options to the fence's shape, anything unset or malformed falls back to the default
export const configOf = (options: PluginOptions | undefined): FenceConfig => {
  const o = options ?? {};
  const worktrees = trimSlashes(textOf(o.worktreesDir, DEFAULTS.worktreesDir));
  // anchored at the session root or one of its own worktrees, where a lane runs; an includes()
  // would let /repo/src/.claude/features/CC-1/ and another repo's record folder through
  const lane = worktrees === "" ? "" : `(?:/${esc(worktrees)}/[^/]+)?`;
  const underRoot = (path: string, root: string, rest: string) =>
    new RegExp(`^${esc(root)}${lane}/${rest}`).test(path);
  const allow: Allow[] = listOf(o.recordFolders, DEFAULTS.recordFolders).map(
    (pattern) => ({
      record: () => `${trimSlashes(pattern)}/`,
      holds: (path, w) => underRoot(path, w.root, `${globRe(pattern)}/`),
    }),
  );
  const memory = trimSlashes(textOf(o.memoryRoot, DEFAULTS.memoryRoot));
  if (memory !== "")
    allow.push({
      record: (w) => `${memory}/${w.type}/`,
      holds: (path, w) =>
        underRoot(path, w.root, `${esc(memory)}/${esc(w.type)}/`),
    });
  const rootTmp = trimSlashes(textOf(o.rootTmp, DEFAULTS.rootTmp));
  if (rootTmp !== "")
    allow.push({
      record: () => `the session root's ${rootTmp}/`,
      holds: (path, w) => path.startsWith(`${w.root}/${rootTmp}/`),
    });
  const sys = textOf(o.systemTmp, DEFAULTS.systemTmp).replace(/\/+$/, "");
  const systemTmp = sys.startsWith("/") ? sys : undefined;
  if (systemTmp !== undefined)
    allow.push({
      record: () => `${systemTmp}/`,
      holds: (path, w) => path.startsWith(`${w.tmp}/`),
    });
  const ms =
    typeof o.statDeadlineMs === "number" && o.statDeadlineMs > 0
      ? o.statDeadlineMs
      : DEFAULTS.statDeadlineMs;
  return {
    types: new Set(listOf(o.agentTypes, DEFAULTS.agentTypes)),
    allow,
    systemTmp,
    deadlineMs: ms,
  };
};
// the manifest's declared type of each option; a list option is a comma string or a JSON array
const KINDS: Record<keyof typeof DEFAULTS, "text" | "list" | "number"> = {
  agentTypes: "list",
  recordFolders: "list",
  memoryRoot: "text",
  worktreesDir: "text",
  rootTmp: "text",
  systemTmp: "text",
  statDeadlineMs: "number",
};
const fits = (kind: "text" | "list" | "number", value: unknown) =>
  kind === "number"
    ? typeof value === "number"
    : typeof value === "string" ||
      (kind === "list" &&
        Array.isArray(value) &&
        value.every((item) => typeof item === "string"));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// this mod's own options in one settings source: the first pluginConfigs key, in file order,
// whose name before the @ is lane-fence, so lane-fence@claude-lanes and a bare lane-fence both match
const blockOf = (settings: unknown): Record<string, unknown> => {
  const configs = isRecord(settings) ? settings.pluginConfigs : undefined;
  if (!isRecord(configs)) return {};
  const key = Object.keys(configs).find(
    (k) => k.split("@")[0] === "lane-fence",
  );
  const entry = key === undefined ? undefined : configs[key];
  const options = isRecord(entry) ? entry.options : undefined;
  return isRecord(options) ? options : {};
};

// each later block overlays the options field by field; a field the manifest would not take
// counts as unset, as the engine counts it, so the value beneath stands
export const overlay = (
  options: PluginOptions | undefined,
  ...settings: unknown[]
): PluginOptions => {
  const merged: Record<string, PluginOptions[string]> = { ...options };
  for (const source of settings) {
    const own = blockOf(source);
    for (const [name, kind] of Object.entries(KINDS)) {
      const value = own[name];
      if (fits(kind, value)) merged[name] = value as PluginOptions[string];
    }
  }
  return merged;
};

// a redirect to a device writes no file, 2>/dev/null is every reviewer's habit
const DEVICES = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

const normalize = (path: string, base: string) => {
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path : `${base}/${path}`).split(
    "/",
  )) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
};

// one stat answer: where the path lands, not there, or why it cannot say. only a rejection naming
// ENOENT, the d.ts fs.stat missing-path shape, is not there; a permission error, a hook denying the
// stat, or no stat at all is a refusal that keeps its reason
type Found = { real: string | undefined } | "missing" | { refused: string };
type Stat = (path: string) => Promise<Found>;
const reasonOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);
// the code arm waits for an engine that carries the code, today's rejection is a wrapped message
const isMissing = (err: unknown) =>
  (typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT") ||
  /\bENOENT\b/.test(reasonOf(err));

// one deadline for every stat a call makes, bounded once from the hook's budget: a $.clock wait
// runs that budget on, and past it the .catch fails open, so the stats end with the margin left.
// a budget under the margin refuses at once. a sleep, never after: a refused after never runs its
// fn and the stall comes back, a refused sleep rejects and refuses here. resolves the refusal
const STAT_DEADLINE_MS = 2000;
const BUDGET_MARGIN_MS = 1000;
type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;
export const deadlineOf = (
  remainingMs: number,
  sleep: Sleep,
  signal: AbortSignal,
  capMs: number = STAT_DEADLINE_MS,
): Promise<string> => {
  const bound = Math.min(capMs, remainingMs - BUDGET_MARGIN_MS);
  if (!(bound > 0))
    return Promise.resolve(
      `the hook has ${Math.max(0, Math.floor(remainingMs))} ms of budget left`,
    );
  return sleep(bound, signal).then(
    () => "stat timed out",
    // our own abort ends the call, nothing races it after
    (err: unknown) =>
      signal.aborted
        ? new Promise<string>(() => undefined)
        : `the stat deadline was refused, ${reasonOf(err)}`,
  );
};

// the engine's stat as a Stat, raced against the call's deadline: a stuck mount answers refused
// instead of holding the Bash call, whose .catch never fires on a stall
export const statOf =
  (
    fsStat: (path: string) => Promise<{ realPath?: string }>,
    deadline: () => Promise<string>,
  ): Stat =>
  (path) =>
    Promise.race<Found>([
      fsStat(path).then(
        (s) => ({ real: s.realPath }),
        (err: unknown) =>
          isMissing(err) ? "missing" : { refused: reasonOf(err) },
      ),
      deadline().then((why) => ({ refused: why })),
    ]);

// where a write lands: the path's own realPath, else on a missing path the nearest ancestor that
// stats with the rest of the spelling under its realPath, so a new file under a linked folder is
// judged where it lands. a stat with no realPath, a refused stat, and a climb that reaches / with
// nothing found are one answer, unplaced with the reason; the spelling is never the fallback
type Placed = { at: string } | { why: string };
export const place = async (path: string, stat: Stat): Promise<Placed> => {
  let head = path;
  let rest = "";
  for (;;) {
    const found = await stat(head);
    if (found === "missing") {
      if (head === "/") return { why: `nothing on the path ${path} stats` };
      const cut = head.lastIndexOf("/");
      rest = `${head.slice(cut)}${rest}`;
      head = cut <= 0 ? "/" : head.slice(0, cut);
    } else if ("refused" in found)
      return { why: `the stat of ${head} was refused, ${found.refused}` };
    else if (found.real === undefined)
      return {
        why: `${head} stats with no real path, a link that leads nowhere`,
      };
    else return { at: normalize(`${found.real}${rest}`, "/") };
  }
};

// the shell follows a link before it applies the .. after it, so a shell spelling is placed one ..
// at a time: the folder before it lands first, .. takes that landing's parent, then the rest
export const placeShell = async (
  spelled: string,
  stat: Stat,
): Promise<Placed> => {
  const parts = spelled
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  const up = parts.indexOf("..");
  if (up < 0) return place(`/${parts.join("/")}`, stat);
  const folder = await place(`/${parts.slice(0, up).join("/")}`, stat);
  if ("why" in folder) return folder;
  return placeShell(
    `${folder.at.slice(0, folder.at.lastIndexOf("/"))}/${parts.slice(up + 1).join("/")}`,
    stat,
  );
};

// rm and mv act on the name itself, never through it: the folder is placed and the leaf appended,
// so a link is judged where it sits. a trailing slash, . or .. follows the name, placed whole
const placeLeaf = async (spelled: string, stat: Stat): Promise<Placed> => {
  const cut = spelled.lastIndexOf("/");
  const leaf = spelled.slice(cut + 1);
  if (leaf === "" || leaf === "." || leaf === "..")
    return placeShell(spelled, stat);
  const folder = await placeShell(spelled.slice(0, cut) || "/", stat);
  if ("why" in folder) return folder;
  return { at: `${folder.at === "/" ? "" : folder.at}/${leaf}` };
};

// the folder an rm reaches through, as placeLeaf cuts it: a trailing slash, . or .. keeps it whole
const folderOf = (spelled: string) => {
  const cut = spelled.lastIndexOf("/");
  const leaf = spelled.slice(cut + 1);
  return leaf === "" || leaf === "." || leaf === ".."
    ? spelled
    : spelled.slice(0, cut) || "/";
};

// a path at or under a folder
const within = (path: string, folder: string) =>
  path === folder || path.startsWith(folder === "/" ? "/" : `${folder}/`);

// each place the shell reaches walking a spelling, a .. folding as it comes, so a write passing
// through a name is seen even when a later .. climbs back out of it
const walked = (spelled: string) => {
  const parts: string[] = [];
  const reached: string[] = [];
  for (const part of spelled.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
    reached.push(`/${parts.join("/")}`);
  }
  return reached;
};

// the heredoc pass: the opener line stays whole so `cat <<EOF > f` still
// shows its redirect, each queued body is cut, a comment or a here-string opens nothing. each body
// is kept with its opener's offset in the stripped text, so the command reading it can be found
const HEREDOC_OPEN =
  /<<-?[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|\\?([^\s;&|<>()'"`]+))/y;
type Heredoc = { at: number; body: string };
const walkHeredocs = (raw: string) => {
  let out = "";
  let pending: Array<{ term: string; at: number }> = [];
  const docs: Heredoc[] = [];
  let quote = "";
  let arith = 0;
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const ch = raw[i] ?? "";
    if (quote !== "") {
      out += ch;
      if (ch === "\\" && quote === '"' && i + 1 < n) {
        out += raw[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = "";
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "\\" && i + 1 < n) {
      out += raw.slice(i, i + 2);
      i += 2;
      continue;
    } else if (
      ch === "#" &&
      (i === 0 || " \t\n;&|(".includes(raw[i - 1] ?? ""))
    ) {
      const j = raw.indexOf("\n", i);
      const end = j < 0 ? n : j;
      out += raw.slice(i, end);
      i = end;
      continue;
    } else if (raw.startsWith("((", i)) {
      arith++;
      out += "((";
      i += 2;
      continue;
    } else if (raw.startsWith("))", i) && arith > 0) {
      arith--;
      out += "))";
      i += 2;
      continue;
    } else if (raw.startsWith("<<<", i)) {
      out += "<<<";
      i += 3;
      continue;
    } else if (raw.startsWith("<<", i) && arith === 0) {
      HEREDOC_OPEN.lastIndex = i;
      const m = HEREDOC_OPEN.exec(raw);
      if (m !== null) {
        pending.push({ term: m[1] ?? m[2] ?? m[3] ?? "", at: out.length });
        out += m[0];
        i += m[0].length;
        continue;
      }
    } else if (ch === "\n" && pending.length > 0) {
      out += ch;
      i++;
      for (const { term, at } of pending) {
        const from = i;
        let end = n;
        while (i < n) {
          const j = raw.indexOf("\n", i);
          const line = j < 0 ? raw.slice(i) : raw.slice(i, j);
          const start = i;
          i = j < 0 ? n : j + 1;
          if (line.trim() === term) {
            end = start;
            break;
          }
        }
        docs.push({ at, body: raw.slice(from, end) });
      }
      pending = [];
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, docs };
};

// the pipeline holding offset at, quote-aware: ; && || ( ) and a newline end one, a lone | joins
// its stages, so a heredoc fed to cat and piped on is still the next stage's stdin
const pipelineAt = (text: string, at: number) => {
  let start = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (quote !== "") {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (
      ";()\n".includes(ch) ||
      (ch === "|" && (text[i + 1] === "|" || text[i - 1] === "|")) ||
      (ch === "&" &&
        text[i - 1] !== ">" &&
        text[i - 1] !== "<" &&
        text[i + 1] !== ">")
    ) {
      if (i > at) return { text: text.slice(start, i), at: at - start };
      start = i + 1;
    }
  }
  return { text: text.slice(start), at: at - start };
};

// a pipeline's stages from the one holding offset at onward, split on a lone | outside quotes
const stagesFrom = (pipeline: string, at: number) => {
  const stages: Array<{ text: string; end: number }> = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i <= pipeline.length; i++) {
    const ch = pipeline[i] ?? "";
    if (quote !== "") {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (i === pipeline.length || (ch === "|" && pipeline[i - 1] !== ">")) {
      stages.push({ text: pipeline.slice(start, i), end: i });
      start = i + 1;
    }
  }
  return stages.filter((stage) => stage.end > at).map((stage) => stage.text);
};

// quote-aware split, and an & beside a redirect arrow stays put so 2>&1 is one piece
const splitStatements = (text: string) => {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (quote !== "") {
      cur += ch;
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (
      ch === "&" &&
      (text[i - 1] === ">" || text[i - 1] === "<" || text[i + 1] === ">")
    ) {
      cur += ch;
    } else if (";\n|&()".includes(ch)) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== "");
};

// quoted text masked to x, same length, so a > inside an echo string is no redirect
const mask = (stmt: string) => {
  let out = "";
  let quote = "";
  for (const ch of stmt) {
    if (quote !== "") {
      out += ch === quote ? ch : "x";
      if (ch === quote) quote = "";
    } else {
      if (ch === '"' || ch === "'") quote = ch;
      out += ch;
    }
  }
  return out;
};

const unquote = (word: string) => word.replace(/^(["'])([\s\S]*)\1$/, "$2");
const words = (stmt: string) =>
  (stmt.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote);

// >, >>, >|, &>, 2>, and >&file all write; >&2, 2>&1, and >&- only point or close a stream
const REDIRECT =
  /(?:^|[^<>&\d])(?:\d*|&)(?:>>|>\||>&(?!\s*[\d-])|>(?!&))\s*("[^"]*"|'[^']*'|[^\s<>]+)/g;

const redirects = (stmt: string) => {
  const masked = mask(stmt);
  const targets: string[] = [];
  let rest = "";
  let at = 0;
  for (let m = REDIRECT.exec(masked); m !== null; m = REDIRECT.exec(masked)) {
    const target = m[1] ?? "";
    const start = m.index + m[0].length - target.length;
    targets.push(unquote(stmt.slice(start, start + target.length)));
    rest += stmt.slice(at, m.index + (/^[^<>&\d]/.test(m[0]) ? 1 : 0));
    at = m.index + m[0].length;
  }
  return { targets, rest: rest + stmt.slice(at) };
};

const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "builtin",
  "exec",
  "nice",
  "ionice",
  "time",
  "nohup",
  "xargs",
  "stdbuf",
  "then",
  "do",
  "else",
  "elif",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "eval"]);
const GIT_GLOBAL_WITH_ARG = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
]);
// the subcommands that move the index, the work tree, or a ref; commit and add are judged by their
// pathspecs below, branch and tag only list bare and pass
const GIT_WRITES = new Set([
  "am",
  "apply",
  "checkout",
  "cherry-pick",
  "clean",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "switch",
]);

// a wrapper's own option values and operands sit between it and the command it runs, as in
// timeout 60, nice -n 10, env -u HOME, or uv run --with requests
const WRAPPED = new Map<
  string,
  { valued: ReadonlySet<string>; operands: number }
>([
  [
    "timeout",
    { valued: new Set(["-s", "--signal", "-k", "--kill-after"]), operands: 1 },
  ],
  ["nice", { valued: new Set(["-n", "--adjustment"]), operands: 0 }],
  [
    "ionice",
    {
      valued: new Set([
        "-c",
        "--class",
        "-n",
        "--classdata",
        "-p",
        "--pid",
        "-P",
        "--pgid",
        "-u",
        "--uid",
      ]),
      operands: 0,
    },
  ],
  [
    "sudo",
    {
      valued: new Set([
        "-u",
        "--user",
        "-g",
        "--group",
        "-C",
        "--close-from",
        "-D",
        "--chdir",
        "-h",
        "--host",
        "-p",
        "--prompt",
        "-r",
        "--role",
        "-t",
        "--type",
        "-T",
        "--command-timeout",
        "-U",
        "--other-user",
      ]),
      operands: 0,
    },
  ],
  ["doas", { valued: new Set(["-u", "-C"]), operands: 0 }],
  ["env", { valued: new Set(["-u", "--unset", "-C", "--chdir"]), operands: 0 }],
  ["exec", { valued: new Set(["-a"]), operands: 0 }],
  [
    "stdbuf",
    {
      valued: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
      operands: 0,
    },
  ],
  [
    "xargs",
    {
      valued: new Set([
        "-I",
        "-n",
        "-L",
        "-P",
        "-d",
        "-E",
        "-s",
        "-a",
        "--max-args",
        "--max-lines",
        "--max-procs",
        "--delimiter",
        "--arg-file",
      ]),
      operands: 0,
    },
  ],
  [
    "uv run",
    {
      valued: new Set([
        "--with",
        "--with-editable",
        "--with-requirements",
        "--python",
        "-p",
        "--project",
        "--directory",
        "--package",
        "--env-file",
        "--extra",
        "--group",
        "--only-group",
        "--index",
        "--index-url",
        "--extra-index-url",
      ]),
      operands: 0,
    },
  ],
]);

const firstWord = (w: string[]) => {
  let i = 0;
  while (i < w.length) {
    const word = w[i] ?? "";
    const name = word.split("/").pop() ?? "";
    const wrapper = name === "uv" && w[i + 1] === "run" ? "uv run" : name;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word.startsWith("-")) i++;
    else if (WRAPPERS.has(wrapper) || WRAPPED.has(wrapper)) {
      i += wrapper === "uv run" ? 2 : 1;
      const opts = WRAPPED.get(wrapper);
      if (opts === undefined) continue;
      while (i < w.length && (w[i] ?? "").startsWith("-")) {
        const flag = w[i] ?? "";
        i += opts.valued.has(flag) ? 2 : 1;
        if (flag === "--") break;
      }
      i += opts.operands;
    } else break;
  }
  return i;
};

const operands = (args: string[]) => args.filter((a) => !a.startsWith("-"));
// operands once the values of the named flags are dropped, mkdir -m 755 creates no file named 755
const operandsSkipping = (args: string[], valued: ReadonlySet<string>) =>
  operands(args.filter((_, i) => !valued.has(args[i - 1] ?? "")));
const MKDIR_VALUED = new Set(["-m", "--mode", "--context"]);
const TRUNCATE_VALUED = new Set(["-s", "--size", "-r", "--reference"]);
const INSTALL_VALUED = new Set([
  "-m",
  "--mode",
  "-o",
  "--owner",
  "-g",
  "--group",
  "-S",
  "--suffix",
  "-t",
  "--target-directory",
]);
// the -t folder, glued or as the next word, in a bundle too; valued names the short flags whose
// value follows, so -S.bak or install's -otom never reads as one
const targetDir = (args: string[], valued = "St") => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") break;
    if (a === "--target-directory") return args[i + 1];
    if (a.startsWith("--target-directory="))
      return a.slice("--target-directory=".length);
    if (!/^-[^-]/.test(a)) continue;
    for (let k = 1; k < a.length; k++) {
      const flag = a[k] ?? "";
      if (!valued.includes(flag)) continue;
      const last = k === a.length - 1;
      if (flag === "t") return last ? args[i + 1] : a.slice(k + 1);
      if (last) i++;
      break;
    }
  }
  return undefined;
};

// sed -i: with -e or -f every operand is a file, without them the first operand is the script
const sedFiles = (args: string[]) => {
  if (!args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place")))
    return [];
  const files: string[] = [];
  let script = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-e" || a === "-f" || a === "--expression" || a === "--file") {
      script = true;
      i++;
    } else if (a.startsWith("--expression=") || a.startsWith("--file="))
      script = true;
    else if (!a.startsWith("-")) files.push(a);
  }
  return script ? files : files.slice(1);
};

// perl -i: the -e value is the script, without -e the first operand is the script file
const perlFiles = (args: string[]) => {
  if (!args.some((a) => /^-[a-zA-Z]*i/.test(a))) return [];
  const files: string[] = [];
  let script = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-e" || a === "-E") {
      script = true;
      i++;
    } else if (!a.startsWith("-")) files.push(a);
  }
  return script ? files : files.slice(1);
};

// an inline python or node script names no path this can place, so its write calls are the signal
const SCRIPT_WRITES = new RegExp(
  [
    String.raw`\bopen\([^)]*,\s*(?:mode\s*=\s*)?['"][rbt]*[wax+]`,
    String.raw`\.open\(\s*['"][rbt]*[wax+]`,
    String.raw`\.write\(`,
    String.raw`write_(?:text|bytes)\(`,
    String.raw`\bos\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir|truncate)\(`,
    String.raw`\bshutil\.`,
    String.raw`\.(?:unlink|touch|mkdir|rename|replace)\(`,
    String.raw`\b(?:writeFile|appendFile|createWriteStream|copyFile|cp|rm|rmdir|mkdir|rename|unlink|truncate|symlink)(?:Sync)?\(`,
  ].join("|"),
);
const INLINE_FLAGS: ReadonlyArray<{
  verb: RegExp;
  flags: ReadonlySet<string>;
}> = [
  { verb: /^python(?:\d(?:\.\d+)?)?$/, flags: new Set(["-c"]) },
  {
    verb: /^(?:node|bun|deno)$/,
    flags: new Set(["-e", "--eval", "-p", "--print"]),
  },
];
const inlineScript = (verb: string, args: string[]) => {
  const flags = INLINE_FLAGS.find((f) => f.verb.test(verb))?.flags;
  if (flags === undefined) return undefined;
  const at = args.findIndex((a) => flags.has(a));
  return at >= 0 ? args[at + 1] : undefined;
};

// the interpreter flags that take a value, so the value is never read as a script file
const INTERPRETER_VALUED = new Set([
  "-W",
  "-X",
  "-r",
  "--require",
  "--import",
  "--loader",
  "--input-type",
]);
// an interpreter takes its script from stdin when it names no script: no operand, or a bare -.
// deno reads one only through run -. a -m module or a script file reads stdin as data
const readsStdin = (verb: string, args: string[]) => {
  if (
    !INLINE_FLAGS.some((f) => f.verb.test(verb)) ||
    inlineScript(verb, args) !== undefined
  )
    return false;
  if (args.includes("-m")) return false;
  const named = args.filter(
    (a, i) =>
      a === "-" ||
      (!a.startsWith("-") && !INTERPRETER_VALUED.has(args[i - 1] ?? "")),
  );
  const script =
    verb === "deno" ? (named[0] === "run" ? named[1] : "repl") : named[0];
  return script === undefined || script === "-";
};

// a here-string's word, read off the masked statement so a <<< inside quotes is none, and the
// statement without it, so the word is never taken for a script operand
const HERE_STRING = /<<<[ \t]*("[^"]*"|'[^']*'|[^\s;&|<>()]+)/;
const hereString = (stmt: string): { word?: string; rest: string } => {
  const m = HERE_STRING.exec(mask(stmt));
  if (m === null) return { rest: stmt };
  const end = m.index + m[0].length;
  const word = stmt.slice(end - (m[1] ?? "").length, end);
  return {
    word: unquote(word),
    rest: stmt.slice(0, m.index) + stmt.slice(end),
  };
};

// the interpreter a stage runs when it reads its script from stdin, else undefined
const stdinInterpreter = (stage: string) => {
  // a heredoc opener left on the stage is a redirect, never the script operand
  const w = words(hereString(redirects(stage).rest).rest).filter(
    (word) => !word.startsWith("<<"),
  );
  const i = firstWord(w);
  const verb = (w[i] ?? "").split("/").pop() ?? "";
  return readsStdin(verb, w.slice(i + 1)) ? verb : undefined;
};

// string literals in a script that read as a path, only to name one in the deny text
const pathLiterals = (code: string) =>
  [...code.matchAll(/(['"])([^'"\s{}]+)\1/g)]
    .map((m) => m[2] ?? "")
    .filter(
      (s) =>
        !s.includes("://") &&
        (s.includes("/") || /^[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(s)),
    );

// the paths beside a write call, from the script lines that carry one, so a file read first is
// not the one the deny names
const writtenPaths = (code: string) =>
  code
    .split(/[;\n]/)
    .filter((line) => SCRIPT_WRITES.test(line))
    .flatMap(pathLiterals);

// an unexpanded variable, a substitution, or a home path names no file this can place
const placeable = (path: string) => !/[$`]/.test(path) && !path.startsWith("~");

// base is the directory a relative target resolves against, null once a cd left it unknown. leaf
// marks an rm or mv operand, judged where the name sits; mv also refuses moving a link. into marks
// a folder written inside, never over, so a record folder itself passes
type PathWrite = {
  path: string;
  base: string | null;
  leaf?: "rm" | "mv";
  into?: true;
};
// a command that makes a link. a hard one is refused outright, since it is the file it names and
// no later stat sees through it. a symbolic one, or a copy or extraction keeping links, has its
// destinations judged as plain writes and is refused only when another write in the call lands
// under one, since every stat runs before the command and places that write without the link
type LinkKind = "hard" | "symbolic" | "keep" | "tar";
type Write =
  | PathWrite
  | { git: string }
  | { link: string; kind: LinkKind; to: PathWrite[] }
  | { script: string; code: string };

// cp's flags that make a link instead of a copy, -l hard and -s symbolic, read past a glued -t or
// -S value so the letters of a path are never flags
const cpLinkFlag = (args: string[]) => {
  const flags = shortFlags(args, "St");
  return (
    flags.find((flag) => flag === "-l" || flag === "--link") ??
    flags.find((flag) => flag === "-s" || flag === "--symbolic-link")
  );
};

// the short flags whose value follows, glued or as the next word, so its letters are never flags
const shortFlags = (args: string[], valued: string) => {
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") break;
    if (a.startsWith("--")) flags.push(a.split("=")[0] ?? a);
    else if (a.startsWith("-") && a.length > 1)
      for (let k = 1; k < a.length; k++) {
        const flag = a[k] ?? "";
        flags.push(`-${flag}`);
        if (valued.includes(flag)) {
          if (k === a.length - 1) i++;
          break;
        }
      }
  }
  return flags;
};

// a cp that copies an existing link as a link: -P, -d, and -a keep one, and so does -R or -r
// unless -L follows links; the last of -L and -P wins, as in coreutils
const cpKeepFlag = (args: string[]) => {
  let keep: string | undefined;
  let follow = false;
  let recursive: string | undefined;
  for (const flag of shortFlags(args, "St")) {
    if (["-P", "-d", "-a", "--no-dereference", "--archive"].includes(flag)) {
      keep = flag;
      follow = false;
    } else if (flag === "-L" || flag === "--dereference") {
      keep = undefined;
      follow = true;
    } else if (["-R", "-r", "--recursive"].includes(flag)) recursive = flag;
  }
  return keep ?? (recursive !== undefined && !follow ? recursive : undefined);
};

// rsync keeps a link as a link under -l or -a, unless -L copies the referent
const rsyncKeepFlag = (args: string[]) => {
  const flags = shortFlags(args, "efBTM");
  if (flags.includes("-L") || flags.includes("--copy-links")) return undefined;
  return flags.find((flag) =>
    ["-l", "-a", "--links", "--archive"].includes(flag),
  );
};

// tar extracts under x, bundled old style as its first word, or -x, --extract, or --get
const tarExtracts = (args: string[]) => {
  const first = args[0] ?? "";
  if (/^[A-Za-z]+$/.test(first) && first.includes("x")) return true;
  return shortFlags(args, "fCTXbgKNVHIL").some((flag) =>
    ["-x", "--extract", "--get"].includes(flag),
  );
};

// every folder a tar extraction writes under: each -C or --directory, glued or as the next word,
// else the folder it runs in
const tarDirs = (args: string[]) => {
  const dirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") break;
    if (a === "--directory") dirs.push(args[++i] ?? "");
    else if (a.startsWith("--directory="))
      dirs.push(a.slice("--directory=".length));
    else if (/^-[^-]/.test(a))
      for (let k = 1; k < a.length; k++) {
        const flag = a[k] ?? "";
        if (!"fCTXbgKNVHIL".includes(flag)) continue;
        const value = k === a.length - 1 ? args[++i] : a.slice(k + 1);
        if (flag === "C" && value !== undefined) dirs.push(value);
        break;
      }
  }
  return dirs.length > 0 ? dirs : ["."];
};

// where ln puts its link: the -t folder, the last of two or more operands, or a lone target's
// own name in the folder it runs in
const LN_VALUED = new Set(["-S", "--suffix", "-t", "--target-directory"]);
const lnDest = (args: string[]) => {
  const named = operandsSkipping(args, LN_VALUED);
  const to = targetDir(args);
  if (to !== undefined) return to;
  if (named.length >= 2) return named.at(-1);
  const lone = named[0]?.replace(/\/+$/, "");
  return lone === undefined ? undefined : lone.split("/").pop();
};

// commit and add: the flags that reach past the named paths, and the ones that take a value
const COMMIT_WIDE_SHORT = "aip";
const COMMIT_WIDE_LONG = new Set([
  "--all",
  "--include",
  "--interactive",
  "--patch",
  "--amend",
  "--pathspec-from-file",
]);
const COMMIT_VALUED_SHORT = "mFCct";
const COMMIT_VALUED_LONG = new Set([
  "--message",
  "--file",
  "--reuse-message",
  "--reedit-message",
  "--author",
  "--date",
  "--template",
  "--fixup",
  "--squash",
  "--cleanup",
  "--trailer",
]);
const ADD_WIDE_SHORT = "Au";
const ADD_WIDE_LONG = new Set([
  "--all",
  "--update",
  "--pathspec-from-file",
  "--no-ignore-removal",
]);

// the pathspecs a commit or add names, or the flag that makes it reach past them
const pathspecs = (
  sub: "commit" | "add",
  args: string[],
): { wide: string } | { specs: string[] } => {
  const wideShort = sub === "commit" ? COMMIT_WIDE_SHORT : ADD_WIDE_SHORT;
  const wideLong = sub === "commit" ? COMMIT_WIDE_LONG : ADD_WIDE_LONG;
  const specs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") {
      specs.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const name = a.split("=")[0] ?? a;
      if (wideLong.has(name)) return { wide: `git ${sub} ${name}` };
      if (sub === "commit" && COMMIT_VALUED_LONG.has(name) && !a.includes("="))
        i++;
    } else if (a.startsWith("-") && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const flag = a[k] ?? "";
        if (wideShort.includes(flag)) return { wide: `git ${sub} -${flag}` };
        if (sub === "commit" && COMMIT_VALUED_SHORT.includes(flag)) {
          if (k === a.length - 1) i++;
          break;
        }
      }
    } else specs.push(a);
  }
  return { specs };
};

// what one statement writes; a command this does not know writes nothing it can judge
const scan = (stmt: string, dir: string | null): Write[] => {
  const { targets, rest: unredirected } = redirects(stmt);
  const writes: Write[] = targets.map((path) => ({ path, base: dir }));
  const { word: here, rest } = hereString(unredirected);
  const w = words(rest);
  const i = firstWord(w);
  const verb = (w[i] ?? "").split("/").pop() ?? "";
  const args = w.slice(i + 1);
  const paths = (list: Array<string | undefined>, base = dir) =>
    list.flatMap((path) => (path === undefined ? [] : [{ path, base }]));
  if (SHELLS.has(verb))
    return [...writes, ...args.flatMap((arg) => scanCommand(arg, dir))];
  if (verb === "tee" || verb === "touch")
    return [...writes, ...paths(operands(args))];
  if (verb === "mkdir")
    return [...writes, ...paths(operandsSkipping(args, MKDIR_VALUED))];
  if (verb === "truncate")
    return [...writes, ...paths(operandsSkipping(args, TRUNCATE_VALUED))];
  if (verb === "sed") return [...writes, ...paths(sedFiles(args))];
  if (verb === "perl") return [...writes, ...paths(perlFiles(args))];
  if (verb === "dd")
    return [
      ...writes,
      ...paths(args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3))),
    ];
  // coreutils link takes no flags and makes a hard link, ln does without -s
  if (verb === "link")
    return [...writes, { link: "link", kind: "hard", to: [] }];
  if (verb === "ln") {
    const symbolic = shortFlags(args, "St").find(
      (flag) => flag === "-s" || flag === "--symbolic",
    );
    if (symbolic === undefined)
      return [...writes, { link: "ln", kind: "hard", to: [] }];
    return [
      ...writes,
      { link: `ln ${symbolic}`, kind: "symbolic", to: paths([lnDest(args)]) },
    ];
  }
  const cpTo = () => paths([targetDir(args) ?? operands(args).at(-1)]);
  const cpLink = verb === "cp" ? cpLinkFlag(args) : undefined;
  if (cpLink !== undefined)
    return [
      ...writes,
      {
        link: `cp ${cpLink}`,
        kind: cpLink === "-l" || cpLink === "--link" ? "hard" : "symbolic",
        to: cpTo(),
      },
    ];
  // a copy that keeps an existing link as a link lands it the same way, whatever it points at
  const cpKeep = verb === "cp" ? cpKeepFlag(args) : undefined;
  if (cpKeep !== undefined)
    return [...writes, { link: `cp ${cpKeep}`, kind: "keep", to: cpTo() }];
  const rsyncKeep = verb === "rsync" ? rsyncKeepFlag(args) : undefined;
  if (rsyncKeep !== undefined)
    return [
      ...writes,
      {
        link: `rsync ${rsyncKeep}`,
        kind: "keep",
        to: paths([operands(args).at(-1)]),
      },
    ];
  if (verb === "tar" && tarExtracts(args))
    return [
      ...writes,
      {
        link: "tar x",
        kind: "tar",
        to: paths(tarDirs(args)).map((dest) => ({
          ...dest,
          into: true as const,
        })),
      },
    ];
  const leaves = (list: string[], leaf: "rm" | "mv") =>
    list.map((path) => ({ path, base: dir, leaf }));
  if (verb === "rm") return [...writes, ...leaves(operands(args), "rm")];
  if (verb === "mv") {
    // the destination is followed, a link to a folder takes the file inside it
    const to = targetDir(args);
    const named = operands(args).filter((a) => a !== to);
    const sources = to === undefined ? named.slice(0, -1) : named;
    return [
      ...writes,
      ...leaves(sources, "mv"),
      ...paths([to ?? named.at(-1)]),
    ];
  }
  if (verb === "cp")
    return [...writes, ...paths([targetDir(args) ?? operands(args).at(-1)])];
  if (verb === "install") {
    const files = operandsSkipping(args, INSTALL_VALUED);
    const dirsOnly = args.some((a) => a === "-d" || a === "--directory");
    return [
      ...writes,
      ...paths(dirsOnly ? files : [targetDir(args, "mogSt") ?? files.at(-1)]),
    ];
  }
  // a here-string feeds an interpreter reading stdin its script, the way -c does
  const code =
    inlineScript(verb, args) ??
    (here !== undefined && readsStdin(verb, args) ? here : undefined);
  if (code !== undefined && SCRIPT_WRITES.test(code))
    return [...writes, { script: verb, code }];
  if (verb === "git") {
    // git -C moves where a pathspec resolves, a relative one off an unknown base stays unknown
    let gitDir = dir;
    let j = 0;
    while (j < args.length && (args[j] ?? "").startsWith("-")) {
      const to = args[j + 1];
      if (args[j] === "-C" && to !== undefined)
        gitDir = !placeable(to)
          ? null
          : to.startsWith("/")
            ? normalize(to, "/")
            : gitDir === null
              ? null
              : normalize(to, gitDir);
      j += GIT_GLOBAL_WITH_ARG.has(args[j] ?? "") ? 2 : 1;
    }
    const sub = args[j] ?? "";
    if (sub === "commit" || sub === "add") {
      const got = pathspecs(sub, args.slice(j + 1));
      if ("wide" in got) return [...writes, { git: got.wide }];
      // a bare commit takes whatever the index holds, a sibling's staged work included
      if (got.specs.length === 0)
        return [...writes, { git: `git ${sub} with no pathspec` }];
      const magic = got.specs.find(
        (spec) => spec.startsWith(":") || !placeable(spec),
      );
      if (magic !== undefined)
        return [...writes, { git: `git ${sub} ${magic}` }];
      return [...writes, ...paths(got.specs, gitDir)];
    }
    const stashWrites =
      sub === "stash" && !["list", "show"].includes(args[j + 1] ?? "");
    if (GIT_WRITES.has(sub) || stashWrites)
      return [...writes, { git: `git ${sub}` }];
  }
  return writes;
};

// a cd to a literal absolute dir moves the base; any other cd, or one beside a subshell whose
// scope the flat split cannot see, leaves it unknown
const scanCommand = (command: string, start: string | null): Write[] => {
  const { text, docs } = walkHeredocs(command);
  const writes: Write[] = [];
  // a heredoc body is data the shell never runs, unless an interpreter reading stdin takes it, as
  // `python3 - <<EOF` or `cat <<EOF | node`: then the body is the script and is read here
  for (const doc of docs) {
    const line = pipelineAt(text, doc.at);
    const verb = stagesFrom(line.text, line.at)
      .map(stdinInterpreter)
      .find((v) => v !== undefined);
    if (verb !== undefined && SCRIPT_WRITES.test(doc.body))
      writes.push({ script: verb, code: doc.body });
  }
  const subshell = /[()]/.test(mask(text));
  let dir = start;
  for (const stmt of splitStatements(text)) {
    writes.push(...scan(stmt, dir));
    const w = words(stmt);
    const k = firstWord(w);
    const verb = w[k] ?? "";
    if (verb === "cd") {
      const to = operands(w.slice(k + 1))[0];
      dir =
        !subshell && to !== undefined && to.startsWith("/") && placeable(to)
          ? normalize(to, "/")
          : null;
    } else if (verb === "pushd" || verb === "popd") dir = null;
  }
  return writes;
};

const REPORT =
  "Report the fix as text with path:line and let the caller apply it.";
// the texts need the agent and its config alone, so a call that writes nothing never places root or tmp
type Fenced = Who & { allow: readonly Allow[] };
const records = (w: Fenced) => {
  const list = w.allow.map((a) => a.record(w));
  if (list.length <= 1) return list[0] ?? "no path at all";
  if (list.length === 2) return `${list[0]} or ${list[1]}`;
  return `${list.slice(0, -1).join(", ")}, or ${list.at(-1) ?? ""}`;
};
const fenceText = (w: Fenced, path: string, real: string) =>
  `fence: ${w.type} is a read-only reviewer and ${path}${real === path ? "" : `, which lands at ${real},`} ` +
  `is outside its record paths. Write only under ${records(w)}. ${REPORT}`;
const unplacedText = (w: Fenced, path: string, why: string) =>
  `fence: ${w.type} is a read-only reviewer and this fence cannot place ${path}, since ${why}, so the ` +
  `write is denied. Write only under ${records(w)}. ${REPORT}`;
const gitText = (w: Fenced, git: string) =>
  `fence: ${w.type} is a read-only reviewer and may not run '${git}', which reaches past its record paths. ` +
  `A reviewer commits only its own record, by pathspec: git commit -m "..." -- <its paths>. ${REPORT}`;
// each link refusal ends on the way to do that work where this fence can still place it
const LINK_TAIL: Record<LinkKind | "mv", string> = {
  hard: "Copy with a plain cp, or cp -rL for a folder.",
  symbolic:
    "Make the link in one call and write in the next, where this fence places a write through it.",
  keep: "Run the copy alone and write in the next call, or follow the links with cp -rL or rsync -L.",
  tar: "Run the extraction alone and write in the next call, where this fence places the links it made.",
  mv: "Copy what it points at with cp -L instead, which lands a file and no link.",
};
const hardText = (w: Fenced, what: string) =>
  `fence: ${w.type} is a read-only reviewer and may not run '${what}', since a hard link is the file it ` +
  `names, so a write to it in any later call lands in that file where no stat can see it. ${LINK_TAIL.hard} ${REPORT}`;
const sameCallText = (w: Fenced, what: string, kind: LinkKind, other: string) =>
  `fence: ${w.type} is a read-only reviewer and may not run '${what}' with a write to ${other} in the ` +
  "same call, since this fence placed that write before the link existed and the shell can write through it. " +
  `${LINK_TAIL[kind]} ${REPORT}`;
const mvLinkText = (w: Fenced, path: string) =>
  `fence: ${w.type} is a read-only reviewer and may not run 'mv' on the link ${path}, since a moved link ` +
  `carries its target to wherever it arrives. ${LINK_TAIL.mv} ${REPORT}`;
const lostText = (w: Fenced, path: string) =>
  `fence: ${w.type} is a read-only reviewer and '${path}' is a relative write after a cd this fence ` +
  `cannot resolve, and a reviewer never needs one. Write to an absolute path under ${records(w)}.`;
const scriptText = (
  w: Fenced,
  verb: string,
  named?: { path: string; at: string },
) =>
  `fence: ${w.type} is a read-only reviewer and its inline ${verb} script ` +
  (named === undefined
    ? "writes files this fence cannot place. "
    : `carries a write call and names ${named.path}${named.at === named.path ? "" : `, which lands at ${named.at},`} ` +
      "outside its record paths. ") +
  `Write only under ${records(w)}. ${REPORT}`;

export const register: Register = (on, options) => {
  // the project and local blocks are read once per load, at the first call that needs config,
  // and the config built once from the merge. a source that cannot be read overrides nothing
  let settled: Promise<FenceConfig> | undefined;
  const configured = (
    read: (source: "project" | "local") => Promise<unknown>,
  ) =>
    (settled ??= Promise.all(
      (["project", "local"] as const).map((source) =>
        (async () => read(source))().catch(() => ({})),
      ),
    ).then((sources) => configOf(overlay(options, ...sources))));
  // the Bash half alone: Write, Edit, and NotebookEdit are fenced by a tool permission or a
  // settings hook, which never judges a Bash call
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    if (e.tool !== "Bash") return next(e);
    // no agent id is the main loop, the coordinator writes anywhere
    if (e.agentId === undefined) return next(e);
    // the type is the engine's own record of the spawn, AgentInfo.type, never a name in the
    // prompt; a workflow's or a fork's id is in no list and passes
    const agent = (await $.agent.list()).find((a) => a.id === e.agentId);
    if (agent === undefined) return next(e);
    const config = await configured((source) => $.settings.read({ source }));
    const ALLOW = config.allow;
    if (!config.types.has(agent.type)) return next(e);
    const cwd = await $.session.cwd();
    const who: Fenced = { type: agent.type, allow: ALLOW };
    const refuse = (what: string, deny: string) => {
      $.ui.status(`fence refused ${agent.type}: ${what}`);
      return { deny };
    };
    // the deadline starts on the first stat and reads the budget then, once; the abort in the
    // finally drops its wait when the call is judged
    const stop = new AbortController();
    let deadline: Promise<string> | undefined;
    const stat = statOf(
      (path) => $.fs.stat(path, { resolve: true }),
      () =>
        (deadline ??= deadlineOf(
          next.budget.remainingMs,
          (ms, signal) => $.clock.sleep(ms, { signal }),
          stop.signal,
          config.deadlineMs,
        )),
    );
    // root and /tmp are placed once, on the first write this call judges. an unplaced one keeps
    // its spelling, which a landing matches only when that spelling is already real
    let placing: Promise<Where> | undefined;
    const whereOf = () =>
      (placing ??= $.session.root().then(async (root) => {
        // no system tmp option, nothing to place and no arm reads it
        const sys = config.systemTmp;
        const [r, t] = await Promise.all([
          place(root, stat),
          sys === undefined ? undefined : place(sys, stat),
        ]);
        return {
          type: agent.type,
          root: "at" in r ? r.at : root,
          tmp: t !== undefined && "at" in t ? t.at : (sys ?? ""),
        };
      }));
    // the spelling a path write is placed by, before its .. folds, or null after a lost cd
    const spelledOf = (write: PathWrite) =>
      write.path.startsWith("/")
        ? write.path
        : write.base === null
          ? null
          : `${write.base}/${write.path}`;
    // a path write judged where it lands: its refusal, or undefined to go on
    const judge = async (write: PathWrite) => {
      if (!placeable(write.path)) return undefined;
      if (write.base === null && !write.path.startsWith("/"))
        return refuse(`${write.path} after a cd`, lostText(who, write.path));
      const base = write.base ?? cwd;
      const path = normalize(write.path, base);
      // a .. can climb through a link to a device-named path that is no device, so it is placed
      if (DEVICES.test(path) && !write.path.split("/").includes(".."))
        return undefined;
      // placed as spelled, before .. folds, since the shell follows a link before its ..
      const spelled = write.path.startsWith("/")
        ? write.path
        : `${base}/${write.path}`;
      const placed = await (write.leaf === undefined ? placeShell : placeLeaf)(
        spelled,
        stat,
      );
      if ("why" in placed)
        return refuse(path, unplacedText(who, path, placed.why));
      if (write.leaf === "mv") {
        // a moved link carries its target to wherever it arrives, the same as one ln makes
        const through = await placeShell(spelled, stat);
        if ("why" in through)
          return refuse(path, unplacedText(who, path, through.why));
        if (through.at !== placed.at)
          return refuse(`mv of the link ${path}`, mvLinkText(who, path));
      }
      // a .. spelling that truly lands on a device writes no file either
      if (DEVICES.test(placed.at)) return undefined;
      const where = await whereOf();
      const lands =
        write.into === true
          ? `${placed.at === "/" ? "" : placed.at}/`
          : placed.at;
      if (ALLOW.some((a) => a.holds(lands, where))) return undefined;
      return refuse(path, fenceText(who, path, placed.at));
    };
    // the first other write of the call that reaches through a link this one makes, at or under
    // a destination by its spelling, its walk, or its landing. every other write counts, not only
    // a later one, since a loop, a function, or a background & runs an earlier one after the link.
    // a write or destination this cannot place may reach through it, so it counts too
    const throughLink = async (to: PathWrite[], others: Write[]) => {
      const rest = others.flatMap((other) =>
        "link" in other ? other.to : "path" in other ? [other] : [],
      );
      const folders: string[] = [];
      for (const dest of to) {
        const spelled = placeable(dest.path) ? spelledOf(dest) : null;
        if (spelled === null) return rest[0]?.path;
        folders.push(normalize(spelled, "/"));
        const placed = await placeShell(spelled, stat);
        if ("at" in placed) folders.push(placed.at);
      }
      for (const other of rest) {
        const spelled = placeable(other.path) ? spelledOf(other) : null;
        if (spelled === null) return other.path;
        // rm acts on the name, so only the folder it sits in is reached through
        const reach = other.leaf === "rm" ? folderOf(spelled) : spelled;
        const named = normalize(spelled, "/");
        if (
          walked(reach).some((at) =>
            folders.some((folder) => within(at, folder)),
          )
        )
          return named;
        const placed = await placeShell(reach, stat);
        if (
          "at" in placed &&
          folders.some((folder) => within(placed.at, folder))
        )
          return named;
      }
      return undefined;
    };
    // every write of the call in order: the first refusal, or undefined when all of them pass
    const judgeAll = async () => {
      const writes = scanCommand(e.command, cwd);
      for (const write of writes) {
        if ("git" in write) return refuse(write.git, gitText(who, write.git));
        if ("link" in write) {
          if (write.kind === "hard")
            return refuse(write.link, hardText(who, write.link));
          for (const dest of write.to) {
            const denied = await judge(dest);
            if (denied !== undefined) return denied;
          }
          const other = await throughLink(
            write.to,
            writes.filter((w) => w !== write),
          );
          if (other !== undefined)
            return refuse(
              `${write.link} with ${other}`,
              sameCallText(who, write.link, write.kind, other),
            );
          continue;
        }
        if ("script" in write) {
          // any write call refuses; a named path outside the record only sharpens the text, a record
          // path in the script never earns it a pass. each is placed as the root was, so a linked
          // root never reads a record path as outside it
          const where = await whereOf();
          let named: { path: string; at: string } | undefined;
          for (const spelled of writtenPaths(write.code).filter(placeable)) {
            const path = normalize(spelled, cwd);
            if (DEVICES.test(path) && !spelled.split("/").includes(".."))
              continue;
            const placed = await placeShell(
              spelled.startsWith("/") ? spelled : `${cwd}/${spelled}`,
              stat,
            );
            if ("why" in placed || ALLOW.some((a) => a.holds(placed.at, where)))
              continue;
            named = { path, at: placed.at };
            break;
          }
          return refuse(
            `inline ${write.script} write`,
            scriptText(who, write.script, named),
          );
        }
        const denied = await judge(write);
        if (denied !== undefined) return denied;
      }
      return undefined;
    };
    try {
      const denied = await judgeAll();
      if (denied !== undefined) return denied;
    } finally {
      stop.abort();
    }
    return next(e);
  }).catch(($, e, next) => next(e)); // fail open, a broken fence never blocks the session

  // a refusal belongs to the turn it happened in, the main loop's turn end clears it
  on("turn.complete", ($, e, next) => {
    if (e.agentId === undefined) $.ui.status(undefined);
    return next(e);
  }).catch(($, e, next) => next(e));
};
