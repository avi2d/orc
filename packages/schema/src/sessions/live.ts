import type { HarnessProcess, HerdrPane } from "../sources/live-sessions";
import type { LogRoots } from "../sources/session-logs";
import type { CountedCall, LogFile } from "./ledger";
import type { Harness } from "./log-lines";

export type SessionIdentity =
  | { readonly kind: "pane"; readonly pane: string; readonly status: string | undefined }
  | { readonly kind: "process"; readonly pid: number }
  | { readonly kind: "ended" };

export interface Session {
  readonly id: string;
  readonly identity: SessionIdentity;
  readonly harness: Harness;
  readonly cwd: string | undefined;
  readonly place: string;
  readonly files: ReadonlyArray<string>;
  readonly machine?: string;
}

export interface UnmatchedRuns {
  readonly harness: Harness;
  readonly cwd: string;
  readonly place: string;
  readonly pids: ReadonlyArray<number>;
  readonly machine?: string;
}

export interface LiveContext {
  readonly home: string;
  readonly roots: LogRoots;
  readonly panes: ReadonlyArray<HerdrPane>;
  readonly processes: ReadonlyArray<HarnessProcess>;
}

interface FileFacts {
  readonly harness: Harness;
  readonly cwd: string | undefined;
  readonly modifiedAt: number;
}

const cwdOf = (file: LogFile): string | undefined => {
  for (const record of file.records) {
    if (record.kind === "pi-session" || record.kind === "codex-session") return record.cwd;
    if (record.kind === "claude-code-call" && record.cwd !== undefined) return record.cwd;
  }
  return undefined;
};

const subagents = "/subagents/";

// A Claude Code subagent writes its own file under its parent session's directory, and belongs to that session.
const ownerOf = (path: string): string =>
  path.includes(subagents) ? `${path.slice(0, path.lastIndexOf(subagents))}.jsonl` : path;

const directoryOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

const piFolder = (roots: LogRoots, cwd: string): string =>
  `${roots.pi}/--${cwd.replace(/^\//, "").replaceAll("/", "-")}--`;

const claudeCodeFolder = (roots: LogRoots, cwd: string): string =>
  `${roots["claude-code"]}/${cwd.replaceAll(/[^A-Za-z0-9]/g, "-")}`;

const programHarness = { pi: "pi", claude: "claude-code", codex: "codex" } as const satisfies Record<
  HarnessProcess["program"],
  Harness
>;

const harnessOfProgram = new Map<string, Harness>(Object.entries(programHarness));

// Codex files its rollouts by date, so for Codex the working directory stands in for a log folder.
const logFolder = (harness: Harness, cwd: string, roots: LogRoots): string => {
  switch (harness) {
    case "pi":
      return piFolder(roots, cwd);
    case "claude-code":
      return claudeCodeFolder(roots, cwd);
    case "codex":
      return cwd;
  }
};

const folderKey = (harness: Harness, folder: string): string => `${harness} ${folder}`;

const agentHarness = new Map<string, Harness>([
  ["pi", "pi"],
  ["claude", "claude-code"],
  ["codex", "codex"],
]);

export const tieFolderOf = (pane: HerdrPane, roots: LogRoots, files: ReadonlyMap<string, LogFile>): string | undefined => {
  const session = pane.agent_session;
  if (session === undefined || session === null) return pane.cwd;
  if (session.kind !== "path") return undefined;
  const harness = agentHarness.get(pane.agent ?? "");
  if (harness === undefined) return undefined;
  const folder = directoryOf(session.value);
  if (pane.cwd !== undefined && logFolder(harness, pane.cwd, roots) === folder) return pane.cwd;
  const recorded = files.get(session.value);
  const known = recorded === undefined ? undefined : cwdOf(recorded);
  if (known !== undefined && (harness === "codex" || logFolder(harness, known, roots) === folder)) return known;
  return undefined;
};

const newestFileIn = (harness: Harness, folder: string, facts: ReadonlyMap<string, FileFacts>): string | undefined => {
  const candidates = [...facts.entries()].filter(([path, fact]) =>
    fact.harness !== harness ? false : harness === "codex" ? fact.cwd === folder : directoryOf(path) === folder,
  );
  return candidates.toSorted(([, a], [, b]) => b.modifiedAt - a.modifiedAt).at(0)?.[0];
};

const shortId = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.jsonl$/, "").slice(-6);

export const placeOf = (cwd: string | undefined, home: string): string => {
  if (cwd === undefined) return "unknown place";
  const relative = cwd === home || cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
  const pooled = /^~\/\.treehouse\/([^/]+)\/([^/]+)/.exec(relative);
  if (pooled !== null) return `${pooled[1]}/${pooled[2]}`;
  const pipeline = /^~\/\.no-mistakes\/worktrees\/[^/]+\/([^/]+)/.exec(relative);
  if (pipeline !== null) return `no-mistakes ${pipeline[1]?.slice(-6)}`;
  return relative;
};

export const sessionSuffix = (session: Session): string => {
  switch (session.identity.kind) {
    case "pane":
      return session.identity.pane;
    case "process":
      return `pid ${session.identity.pid}`;
    case "ended":
      return `#${shortId(session.files.at(0) ?? "")}`;
  }
};

export const sessionLabel = (session: Session): string => `${session.place} ${sessionSuffix(session)}`;

export interface ResolvedSessions {
  readonly sessions: ReadonlyArray<Session>;
  readonly sessionOfFile: ReadonlyMap<string, string>;
  readonly unmatched: ReadonlyArray<UnmatchedRuns>;
  readonly headless: ReadonlyArray<string>;
}

interface Reservations {
  readonly folders: ReadonlySet<string>;
  readonly paneRuns: ReadonlyMap<string, number>;
}

const reservations = (live: LiveContext, claimed: ReadonlyMap<string, Session>): Reservations => {
  const paneRuns = new Map<string, number>();
  for (const pane of live.panes) {
    const harness = harnessOfProgram.get(pane.agent ?? "");
    if (harness === undefined) continue;
    const session = pane.agent_session;
    const folder =
      session?.kind === "path" && harness !== "codex"
        ? directoryOf(session.value)
        : pane.cwd === undefined
          ? undefined
          : logFolder(harness, pane.cwd, live.roots);
    if (folder === undefined) continue;
    const key = folderKey(harness, folder);
    paneRuns.set(key, (paneRuns.get(key) ?? 0) + 1);
  }
  const claimedFolders = [...claimed].flatMap(([path, session]) => {
    const folder = session.harness === "codex" ? session.cwd : directoryOf(path);
    return folder === undefined ? [] : [folderKey(session.harness, folder)];
  });
  return { folders: new Set([...paneRuns.keys(), ...claimedFolders]), paneRuns };
};

interface FolderRuns {
  readonly harness: Harness;
  readonly folder: string;
  readonly cwd: string;
  readonly runs: Array<HarnessProcess>;
}

const runsByFolder = (live: LiveContext): ReadonlyMap<string, FolderRuns> => {
  const piPids = new Set(live.processes.filter((process) => process.program === "pi").map((process) => process.pid));
  const groups = new Map<string, FolderRuns>();
  for (const process of live.processes) {
    if (process.program === "claude" && piPids.has(process.parent)) continue;
    const harness = programHarness[process.program];
    const folder = logFolder(harness, process.cwd, live.roots);
    const key = folderKey(harness, folder);
    const known = groups.get(key);
    if (known === undefined) groups.set(key, { harness, folder, cwd: process.cwd, runs: [process] });
    else known.runs.push(process);
  }
  return groups;
};

interface Headless {
  readonly matched: ReadonlyArray<{ readonly pid: number; readonly path: string; readonly harness: Harness; readonly cwd: string; readonly place: string }>;
  readonly unmatched: ReadonlyArray<UnmatchedRuns>;
  readonly lone: ReadonlyArray<string>;
}

// A headless process names no file, so only a process alone in its log folder can take that folder's newest log.
const headlessRuns = (live: LiveContext, facts: ReadonlyMap<string, FileFacts>, claimed: ReadonlyMap<string, Session>): Headless => {
  const { folders, paneRuns } = reservations(live, claimed);
  const matched: Array<Headless["matched"][number]> = [];
  const unmatched: Array<UnmatchedRuns> = [];
  const lone: Array<string> = [];
  for (const [key, { harness, folder, cwd, runs }] of runsByFolder(live)) {
    const reserved = folders.has(key);
    const only = runs.length === 1 ? runs.at(0) : undefined;
    const path = only !== undefined && !reserved ? newestFileIn(harness, folder, facts) : undefined;
    if (only !== undefined && path !== undefined) matched.push({ pid: only.pid, path, harness, cwd, place: placeOf(cwd, live.home) });
    else if (only !== undefined && !reserved) lone.push(cwd);
    else if ((reserved || runs.length > 1) && runs.length > (paneRuns.get(key) ?? 0)) {
      unmatched.push({ harness, cwd, place: placeOf(cwd, live.home), pids: runs.map((run) => run.pid) });
    }
  }
  return { matched, unmatched, lone };
};

// A pane or a live process is the session's identity, and any file with calls that neither claims is a session that ended.
export const resolveSessions = (
  files: ReadonlyArray<LogFile>,
  calls: ReadonlyArray<CountedCall>,
  live: LiveContext,
): ResolvedSessions => {
  const facts = new Map<string, FileFacts>(
    files.map((file) => [file.path, { harness: file.harness, cwd: cwdOf(file), modifiedAt: file.modifiedAt }]),
  );
  const owners = new Map<string, Session>();
  const claim = (path: string, session: Omit<Session, "harness" | "cwd" | "place" | "files">) => {
    const fact = facts.get(path);
    if (fact === undefined || owners.has(path)) return;
    owners.set(path, { ...session, harness: fact.harness, cwd: fact.cwd, place: placeOf(fact.cwd, live.home), files: [path] });
  };
  for (const pane of live.panes) {
    if (pane.agent_session?.kind !== "path") continue;
    claim(pane.agent_session.value, {
      id: `pane:${pane.pane_id}`,
      identity: { kind: "pane", pane: pane.pane_id, status: pane.agent_status },
    });
  }
  const headless = headlessRuns(live, facts, owners);
  for (const { pid, path } of headless.matched) claim(path, { id: `pid:${pid}`, identity: { kind: "process", pid } });
  const ownerFile = (path: string): string => (facts.has(ownerOf(path)) ? ownerOf(path) : path);
  for (const call of calls) {
    const path = ownerFile(call.file);
    claim(path, { id: `file:${path}`, identity: { kind: "ended" } });
  }
  const sessionOfFile = new Map<string, string>();
  const grouped = new Map<string, Session>();
  for (const call of calls) {
    const owner = owners.get(ownerFile(call.file));
    if (owner === undefined) continue;
    sessionOfFile.set(call.file, owner.id);
    const known = grouped.get(owner.id) ?? owner;
    grouped.set(owner.id, known.files.includes(call.file) ? known : { ...known, files: [...known.files, call.file] });
  }
  const emitted = new Set(grouped.keys());
  const preserved = headless.matched.flatMap(({ path, cwd }) => {
    const owner = owners.get(path);
    return owner !== undefined && !emitted.has(owner.id) ? [cwd] : [];
  });
  return { sessions: [...grouped.values()], sessionOfFile, unmatched: headless.unmatched, headless: [...headless.lone, ...preserved] };
};
