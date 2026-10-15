// src path relative to the session root to every writer seen this session, 'coordinator' for the
// main loop; a worktree write keeps its worktree prefix, so two trees never share a key
export type Writes = Record<string, string[]>
// the hash of the recorded paths, the write count, and HEAD at the last judged stop, with the
// files that run named failing before the sentinel was subtracted, and the HEAD it was judged at
export type Memo = { key: string; failing: string[]; head?: string }
// the last judged stop's undeclared reds and their owners, what the status entry redraws from
export type Last = { reds: number; owners: string[] }

declare module 'claude-code' {
  interface PluginState {
    // memo holds one Memo per tree under id memo:<tree>, the main tree's id memo:. held keeps a
    // lane's relative Bash targets by agent id until its stop names the cwd they resolve against
    suite: { writes: Writes; seq: number; memo: StateFamily<Memo>; held: StateFamily<string[]>; last: Last }
  }
}
