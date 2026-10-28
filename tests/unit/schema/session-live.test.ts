import { describe, expect, test } from "bun:test";
import {
  countedCalls,
  decodeTasksReport,
  type HarnessProcess,
  type HerdrPane,
  homeLogRoots,
  type LogFile,
  logRecords,
  resolveSessions,
  taskLevels,
  tieFolderOf,
} from "@tui-dash/schema";
import { taskReadings, tasksNow } from "../../lib/task-levels-fixture";
import { viewOf } from "../../lib/quota-view-fixture";

const home = "/home/tester";

const cwd = `${home}/proj`;

const folder = `${home}/.pi/agent/sessions/--home-tester-proj--`;

const piLog = (name: string, at: string): LogFile => {
  const text = [
    JSON.stringify({ type: "session", version: 3, id: name, timestamp: at, cwd }),
    JSON.stringify({
      type: "message",
      timestamp: at,
      message: { role: "assistant", provider: "opencode-go", model: "glm-5", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } },
    }),
  ].join("\n");
  return { path: `${folder}/${name}.jsonl`, harness: "pi", modifiedAt: Date.parse(at), records: logRecords("pi", text) };
};

const older = piLog("older", "2026-10-13T10:00:00.000Z");

const newer = piLog("newer", "2026-10-13T11:00:00.000Z");

const headless = (pid: number): HarnessProcess => ({ pid, parent: 1, program: "pi", cwd });

const paneOn = (file: LogFile): HerdrPane => ({
  pane_id: "w1A:p1",
  agent: "pi",
  cwd,
  agent_session: { kind: "path", value: file.path },
});

const resolved = (panes: ReadonlyArray<HerdrPane>, processes: ReadonlyArray<HarnessProcess>) => {
  const files = [older, newer];
  return resolveSessions(files, countedCalls(files).calls, { home, roots: homeLogRoots(home), panes, processes });
};

const identities = (result: ReturnType<typeof resolved>) =>
  result.sessions.map((session) => `${session.id} ${session.identity.kind}`).toSorted((a, b) => a.localeCompare(b));

describe("resolveSessions with headless processes that share a log folder", () => {
  test("leaves both logs ended and names both pids when two headless Pi runs share one folder", () => {
    const result = resolved([], [headless(7001), headless(7002)]);
    expect(identities(result)).toEqual([
      `file:${newer.path} ended`,
      `file:${older.path} ended`,
    ]);
    expect(result.unmatched).toEqual([{ harness: "pi", cwd, place: "~/proj", pids: [7001, 7002] }]);
  });

  test("keeps a pane on the older log it resumed and gives its process no newer log", () => {
    const result = resolved([paneOn(older)], [headless(7001)]);
    expect(identities(result)).toEqual([
      `file:${newer.path} ended`,
      "pane:w1A:p1 pane",
    ]);
    expect(result.unmatched).toEqual([]);
  });

  test("names both pids when a headless run shares a folder with a pane's run", () => {
    const result = resolved([paneOn(older)], [headless(7001), headless(7002)]);
    expect(identities(result)).toEqual([
      `file:${newer.path} ended`,
      "pane:w1A:p1 pane",
    ]);
    expect(result.unmatched).toEqual([{ harness: "pi", cwd, place: "~/proj", pids: [7001, 7002] }]);
  });

  test("counts a resumed pane's run under its log folder and leaves the other run headless", () => {
    const elsewhere = { ...paneOn(older), cwd: `${home}/other` };
    const result = resolved([elsewhere], [headless(7001), { ...headless(7002), cwd: `${home}/other` }]);
    expect(identities(result)).toEqual([`file:${newer.path} ended`, "pane:w1A:p1 pane"]);
    expect(result.unmatched).toEqual([]);
    expect(result.headless).toEqual([`${home}/other`]);
  });

  test("reserves the folder of a pane's log even when Herdr names neither the pane's agent nor its cwd", () => {
    const { agent: _, cwd: __, ...bare } = paneOn(older);
    const result = resolved([bare], [headless(7001)]);
    expect(identities(result)).toEqual([`file:${newer.path} ended`, "pane:w1A:p1 pane"]);
    expect(result.unmatched).toEqual([{ harness: "pi", cwd, place: "~/proj", pids: [7001] }]);
  });

  test("a headless run matched to a log with no counted calls warns no one and keeps its folder", () => {
    const header: LogFile = {
      path: `${folder}/header.jsonl`,
      harness: "pi",
      modifiedAt: Date.parse("2026-10-13T12:00:00.000Z"),
      records: logRecords("pi", JSON.stringify({ type: "session", version: 3, id: "header", timestamp: "2026-10-13T12:00:00.000Z", cwd })),
    };
    expect(countedCalls([header]).calls).toEqual([]);
    const result = resolveSessions([header], [], { home, roots: homeLogRoots(home), panes: [], processes: [headless(7001)] });
    expect(result.sessions).toEqual([]);
    expect(result.unmatched).toEqual([]);
    expect(result.headless).toEqual([cwd]);
  });

  test("a lone headless run with no log file warns no one and keeps its folder", () => {
    const result = resolveSessions([], [], { home, roots: homeLogRoots(home), panes: [], processes: [headless(7001)] });
    expect(result.sessions).toEqual([]);
    expect(result.unmatched).toEqual([]);
    expect(result.headless).toEqual([cwd]);
  });

  test("still matches a lone headless run to its folder's newest log", () => {
    const result = resolved([], [headless(7001)]);
    expect(identities(result)).toEqual([
      `file:${older.path} ended`,
      "pid:7001 process",
    ]);
    expect(result.sessions.find((session) => session.id === "pid:7001")?.files).toEqual([newer.path]);
  });
});

test("matches a lone headless Claude Code run to its newest log under the selected config dir, not under ~/.claude/projects", () => {
  const roots = { ...homeLogRoots(home), "claude-code": `${home}/work-claude/projects` };
  const call = JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-13T11:00:00.000Z",
    cwd,
    requestId: "req_w1",
    message: { id: "msg_w1", model: "claude-opus-5-5", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 40 } },
  });
  const log: LogFile = {
    path: `${home}/work-claude/projects/-home-tester-proj/claude-session.jsonl`,
    harness: "claude-code",
    modifiedAt: Date.parse("2026-10-13T11:00:00.000Z"),
    records: logRecords("claude-code", call),
  };
  const result = resolveSessions([log], countedCalls([log]).calls, {
    home,
    roots,
    panes: [],
    processes: [{ pid: 7101, parent: 1, program: "claude", cwd }],
  });
  expect(result.sessions.map((session) => [session.id, session.files])).toEqual([["pid:7101", [log.path]]]);
});

describe("tieFolderOf", () => {
  const roots = homeLogRoots(home);
  const none = new Map<string, LogFile>();
  const moved = `${home}/elsewhere`;

  test("a pane with no agent session ties to the herdr cwd", () => {
    expect(tieFolderOf({ pane_id: "w3C:p2", agent: "claude", agent_status: "idle", cwd }, roots, none)).toBe(cwd);
  });

  test("a pi session without its file ties to nothing, so the task keeps running", () => {
    const path = `${home}/.pi/agent/sessions/--home-tester-work-plot--/2026-10-10T10-00-00-000Z_eeeeeeee-0000-4000-8000-00000000e002.jsonl`;
    const pane: HerdrPane = {
      pane_id: "w4D:p2",
      agent: "pi",
      agent_status: "done",
      cwd,
      agent_session: { kind: "path", value: path },
    };
    expect(tieFolderOf(pane, roots, none)).toBeUndefined();
  });

  test("a Claude Code session outside the herdr folder ties to nothing", () => {
    const pane: HerdrPane = {
      pane_id: "w5E:p2",
      agent: "claude",
      agent_status: "done",
      cwd: moved,
      agent_session: { kind: "path", value: `${home}/.claude/projects/-home-tester-proj/claude-session.jsonl` },
    };
    expect(tieFolderOf(pane, roots, none)).toBeUndefined();
  });

  test("a Codex session ties to its recorded folder", () => {
    const log: LogFile = {
      path: `${home}/codex/2026/10/13/rollout.jsonl`,
      harness: "codex",
      modifiedAt: Date.parse("2026-10-13T11:00:00.000Z"),
      records: logRecords(
        "codex",
        JSON.stringify({ type: "session_meta", payload: { cwd } }),
      ),
    };
    const pane: HerdrPane = {
      pane_id: "w6F:p2",
      agent: "codex",
      agent_status: "done",
      cwd: moved,
      agent_session: { kind: "path", value: log.path },
    };
    expect(tieFolderOf(pane, roots, new Map([[log.path, log]]))).toBe(cwd);
  });
});

describe("a done pane whose log sits in the worktree while herdr names the project folder", () => {
  const worktree = `${home}/work/plot`;
  const project = `${home}/proj`;
  const path = `${home}/.pi/agent/sessions/--home-tester-work-plot--/2026-10-13T11-00-00-000Z_eeeeeeee-0000-4000-8000-00000000e002.jsonl`;
  const text = [
    JSON.stringify({ type: "session", version: 3, id: "e002", timestamp: "2026-10-13T11:00:00.000Z", cwd: worktree }),
    JSON.stringify({
      type: "message",
      timestamp: "2026-10-13T11:30:00.000Z",
      message: { role: "assistant", provider: "opencode-go", model: "glm-5", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } },
    }),
  ].join("\n");
  const log: LogFile = {
    path,
    harness: "pi",
    modifiedAt: Date.parse("2026-10-13T12:00:00.000Z"),
    records: logRecords("pi", text),
  };
  const pane: HerdrPane = {
    pane_id: "w4D:p2",
    agent: "pi",
    agent_status: "done",
    cwd: project,
    agent_session: { kind: "path", value: path },
  };
  const roots = homeLogRoots(home);

  test("the pane's own run in the worktree matches nothing, so no shared-logs warning reads", () => {
    const result = resolveSessions([log], countedCalls([log]).calls, {
      home,
      roots,
      panes: [pane],
      processes: [{ pid: 7201, parent: 1, program: "pi", cwd: worktree }],
    });
    expect(result.sessions.map((session) => session.id)).toEqual(["pane:w4D:p2"]);
    expect(result.unmatched).toEqual([]);
    expect(result.headless).toEqual([]);
  });

  test("the pane's done status rests the worktree task", () => {
    const tie = tieFolderOf(pane, roots, new Map([[log.path, log]]));
    expect(tie).toBe(worktree);
    const tasks = decodeTasksReport(
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-10-13T20:18:16.000Z",
        orchestrator: { name: "plot", version: "0.9.0" },
        tasks: [
          {
            id: "tasks-plot",
            title: "Plot the work",
            project: "plot",
            kind: "build",
            state: "working",
            detail: "",
            startedAt: "2026-10-12T15:18:16.000Z",
            firstStartedAt: "2026-10-12T15:18:16.000Z",
            endedAt: null,
            folders: [worktree],
            branches: [],
          },
        ],
        overhead: [],
        schedules: [],
      }),
    );
    const base = viewOf({ now: tasksNow.epochMilliseconds, weekStatus: "on_pace", weekLeft: 60 }, [], []);
    const levels = taskLevels(
      taskReadings({ tasks, live: undefined, sessions: { ...base, panePresence: [{ pane: "w4D:p2", status: "done", tie }] } }),
    );
    const row = levels.projects.find((candidate) => candidate.name === "plot")?.tasks.find((task) => task.id === "tasks-plot");
    expect(row?.idled).toBe(true);
    expect(row?.state).toBe("parked");
    expect(row?.seconds).toBe(578635);
  });
});
