import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  decodeHerdrPanes,
  decodeTasksReport,
  ok,
  runsWork,
  type Session,
  SessionQuotaReport,
  sessionQuotaReport,
  sessionQuotaViewOf,
  SessionsCodec,
  taskLevels,
  unreachable,
} from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";
import { recordedNow, sessionViewOfQuota } from "../../lib/session-fixture";
import { viewOf } from "../../lib/quota-view-fixture";
import { live, taskReadings, tasksNow } from "../../lib/task-levels-fixture";

const herdrStatusOf = (pane: string): string | undefined =>
  valueOf(decodeHerdrPanes(fixture("session-logs/herdr-agents.json"))).find((listed) => listed.pane_id === pane)?.agent_status;

const paneIn = (cwd: string, pane: string): Session => ({
  id: `pane:${pane}`,
  identity: { kind: "pane", pane, status: herdrStatusOf(pane) },
  harness: "pi",
  cwd,
  place: cwd,
  files: [`/logs/${pane}.jsonl`],
});

const levelsWith = (...panes: ReadonlyArray<Session>) => taskLevels(taskReadings({ sessions: tiedSessions(...panes) }));

const tiedPresence = (...panes: ReadonlyArray<Session>) =>
  panes.flatMap((session) =>
    session.identity.kind === "pane" && session.cwd !== undefined
      ? [{ pane: session.identity.pane, status: session.identity.status, tie: session.cwd }]
      : [],
  );

const tiedSessions = (...panes: ReadonlyArray<Session>) => {
  const base = viewOf({ now: tasksNow.epochMilliseconds, weekStatus: "on_pace", weekLeft: 60 }, panes, []);
  return { ...base, panePresence: tiedPresence(...panes) };
};

const harborTask = (levels: ReturnType<typeof taskLevels>, id: string) => {
  const task = levels.projects.find((project) => project.name === "harbor")?.tasks.find((row) => row.id === id);
  if (task === undefined) throw new Error(`no task ${id}`);
  return task;
};

const harbor = "/home/example/work/harbor";

const idle29hTasks = (folders: ReadonlyArray<string> = [harbor]) =>
  decodeTasksReport(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-10-19T08:02:11.000Z",
      orchestrator: { name: "harbor", version: "0.9.0" },
      tasks: [
        {
          id: "tasks-29h",
          title: "29h idle",
          project: "harbor",
          kind: "build",
          state: "working",
          detail: "",
          startedAt: "2026-10-18T03:02:11.000Z",
          firstStartedAt: "2026-10-18T03:02:11.000Z",
          endedAt: null,
          folders,
          branches: [],
        },
      ],
      overhead: [],
      schedules: [],
    }),
  );

const idle29hRow = (levels: ReturnType<typeof taskLevels>) => {
  const row = levels.projects.find((project) => project.name === "harbor")?.tasks.find((task) => task.id === "tasks-29h");
  if (row === undefined) throw new Error("no task tasks-29h");
  return row;
};

describe("a task runs work only where no herdr pane over its folder has a working agent, by herdr's recorded agent_status of done for w4D:p2, idle for w2B:p2 and working for w1A:p2", () => {
  test("a done pane over the harbor folder leaves the waiting task there with its live processes and none of them running work", () => {
    const inbox = harborTask(levelsWith(paneIn(harbor, "w4D:p2")), "tasks-inbox-sweep");
    expect(inbox.live?.processes.length).toBeGreaterThan(0);
    expect(runsWork(inbox.live)).toBe(false);
  });

  test("an idle pane rests its folder the same way", () => {
    expect(runsWork(harborTask(levelsWith(paneIn(harbor, "w2B:p2")), "tasks-inbox-sweep").live)).toBe(false);
  });

  test("the done pane rests only its own folder, so the pipeline in the bridge task's no-mistakes worktree still runs", () => {
    const bridge = harborTask(levelsWith(paneIn(harbor, "w4D:p2")), "tasks-bridge-plot");
    expect(bridge.live?.processes.filter((process) => !process.resting).map((process) => process.program)).toEqual(["node", "git", "python3"]);
    expect(runsWork(bridge.live)).toBe(true);
  });

  test("a working pane beside the done one over the same folder keeps that folder running", () => {
    expect(runsWork(harborTask(levelsWith(paneIn(harbor, "w4D:p2"), paneIn(harbor, "w1A:p2")), "tasks-inbox-sweep").live)).toBe(true);
  });

  test("a folder with no pane says nothing of its agent, so its live processes run work", () => {
    expect(runsWork(harborTask(levelsWith(), "tasks-inbox-sweep").live)).toBe(true);
  });

  test("pane presence without a counted session still rests its folder", () => {
    const empty = viewOf({ now: tasksNow.epochMilliseconds, weekStatus: "on_pace", weekLeft: 60 }, [], []);
    const withPresence = { ...empty, panePresence: [{ pane: "w4D:p2", status: "done", tie: harbor }] };
    const inbox = harborTask(taskLevels(taskReadings({ sessions: withPresence })), "tasks-inbox-sweep");
    expect(inbox.live?.processes.length).toBeGreaterThan(0);
    expect(runsWork(inbox.live)).toBe(false);
  });

  test("the panePresence tie wins over the session's log cwd", () => {
    const stray = { ...paneIn("/home/example/work/elsewhere", "w4D:p2") };
    const base = viewOf({ now: tasksNow.epochMilliseconds, weekStatus: "on_pace", weekLeft: 60 }, [stray], []);
    const withPresence = { ...base, panePresence: [{ pane: "w4D:p2", status: "done", tie: harbor }] };
    const inbox = harborTask(taskLevels(taskReadings({ sessions: withPresence })), "tasks-inbox-sweep");
    expect(runsWork(inbox.live)).toBe(false);
  });

  test("a headless process overlapping a resting folder keeps it running", () => {
    const running: Session = {
      id: "proc:9999",
      identity: { kind: "process", pid: 9999 },
      harness: "pi",
      cwd: harbor,
      place: harbor,
      files: [],
    };
    expect(runsWork(harborTask(levelsWith(paneIn(harbor, "w4D:p2"), running), "tasks-inbox-sweep").live)).toBe(true);
  });

  test("an unmatched headless run overlapping a resting folder keeps it running", () => {
    const base = viewOf({ now: tasksNow.epochMilliseconds, weekStatus: "on_pace", weekLeft: 60 }, [paneIn(harbor, "w4D:p2")], []);
    const withUnmatched = { ...base, unmatched: [{ harness: "pi" as const, cwd: harbor, place: harbor, pids: [9999] }] };
    const inbox = harborTask(taskLevels(taskReadings({ sessions: withUnmatched })), "tasks-inbox-sweep");
    expect(runsWork(inbox.live)).toBe(true);
  });

  test("a report without pane presence still decodes", () => {
    const view = viewOf({ now: tasksNow.epochMilliseconds, weekStatus: "on_pace", weekLeft: 60 }, [paneIn(harbor, "w4D:p2")], []);
    const report = sessionQuotaReport(view);
    const { panePresence: _, ...old } = report;
    const reread = valueOf(sessionQuotaViewOf(Schema.decodeUnknownSync(SessionQuotaReport)(JSON.parse(JSON.stringify(old))), "north"));
    expect(reread.panePresence ?? []).toEqual([]);
  });

  test("a stale working log folder does not mark the done pane's folder running", () => {
    const stale = paneIn(harbor, "w1A:p2");
    const base = viewOf({ now: tasksNow.epochMilliseconds, weekStatus: "on_pace", weekLeft: 60 }, [stale, paneIn(harbor, "w4D:p2")], []);
    const withPresence = {
      ...base,
      panePresence: [
        { pane: "w1A:p2", status: "working", tie: "/home/example/work/new" },
        { pane: "w4D:p2", status: "done", tie: harbor },
      ],
    };
    const inbox = harborTask(taskLevels(taskReadings({ sessions: withPresence })), "tasks-inbox-sweep");
    expect(runsWork(inbox.live)).toBe(false);
  });

  test("a working task started 29h ago with only a done pane reads idle, not working", () => {
    const levels = taskLevels(taskReadings({ tasks: idle29hTasks(), sessions: tiedSessions(paneIn(harbor, "w4D:p2")) }));
    const row = idle29hRow(levels);
    expect(row.live?.processes.length).toBeGreaterThan(0);
    expect(runsWork(row.live)).toBe(false);
    expect(row.idled).toBe(true);
    expect(row.state).toBe("parked");
    expect(row.seconds).toBe(29 * 3600);
    expect(levels.projects.find((project) => project.name === "harbor")?.working).toBe(0);
  });

  test("a working task started 29h ago with only a done pane reads idle with no live statistics", () => {
    const levels = taskLevels(
      taskReadings({ tasks: idle29hTasks(), live: undefined, sessions: tiedSessions(paneIn(harbor, "w4D:p2")) }),
    );
    const row = idle29hRow(levels);
    expect(row.live).toBeUndefined();
    expect(row.idled).toBe(true);
    expect(row.state).toBe("parked");
    expect(row.seconds).toBe(29 * 3600);
    expect(levels.projects.find((project) => project.name === "harbor")?.working).toBe(0);
  });

  test("a working task started 29h ago with only a done pane reads idle when its processes predate it", () => {
    const samples = live();
    const predated = {
      ...samples,
      samples: {
        ...samples.samples,
        before: samples.samples.before.map((process) => ({ ...process, startedAtMillis: 0 })),
        after: samples.samples.after.map((process) => ({ ...process, startedAtMillis: 0 })),
      },
    };
    const levels = taskLevels(
      taskReadings({ tasks: idle29hTasks(), live: ok(predated), sessions: tiedSessions(paneIn(harbor, "w4D:p2")) }),
    );
    const row = idle29hRow(levels);
    expect(row.live).toBeUndefined();
    expect(row.idled).toBe(true);
    expect(row.state).toBe("parked");
    expect(row.seconds).toBe(29 * 3600);
    expect(levels.projects.find((project) => project.name === "harbor")?.working).toBe(0);
  });

  test("a lone headless run folder keeps a working task running under its done pane", () => {
    const base = viewOf({ now: tasksNow.epochMilliseconds, weekStatus: "on_pace", weekLeft: 60 }, [paneIn(harbor, "w4D:p2")], []);
    const levels = taskLevels(
      taskReadings({ tasks: idle29hTasks(), live: undefined, sessions: { ...base, headlessFolders: [{ cwd: harbor }] } }),
    );
    const row = idle29hRow(levels);
    expect(row.live).toBeUndefined();
    expect(row.idled).toBe(false);
    expect(row.state).toBe("working");
    expect(levels.projects.find((project) => project.name === "harbor")?.working).toBe(1);
  });

  test("a done pane in a subfolder reads the whole task folder idle with no live statistics", () => {
    const repo = "/home/example/work/repo";
    const base = viewOf({ now: tasksNow.epochMilliseconds, weekStatus: "on_pace", weekLeft: 60 }, [], []);
    const withPresence = { ...base, panePresence: [{ pane: "w4D:p2", status: "done", tie: `${repo}/packages/schema` }] };
    const levels = taskLevels(taskReadings({ tasks: idle29hTasks([repo]), live: undefined, sessions: withPresence }));
    const row = idle29hRow(levels);
    expect(row.live).toBeUndefined();
    expect(row.idled).toBe(true);
    expect(row.state).toBe("parked");
    expect(row.seconds).toBe(29 * 3600);
    expect(levels.projects.find((project) => project.name === "harbor")?.working).toBe(0);
  });

  test("a working pane in a subfolder keeps the task folder running with no live statistics", () => {
    const repo = "/home/example/work/repo";
    const base = viewOf({ now: tasksNow.epochMilliseconds, weekStatus: "on_pace", weekLeft: 60 }, [], []);
    const withPresence = {
      ...base,
      panePresence: [
        { pane: "w4D:p2", status: "done", tie: repo },
        { pane: "w1A:p2", status: "working", tie: `${repo}/packages/schema` },
      ],
    };
    const levels = taskLevels(taskReadings({ tasks: idle29hTasks([repo]), live: undefined, sessions: withPresence }));
    const row = idle29hRow(levels);
    expect(row.idled).toBe(false);
    expect(row.state).toBe("working");
    expect(levels.projects.find((project) => project.name === "harbor")?.working).toBe(1);
  });

  test("a working pane in one folder keeps the task running when its processes predate the task", () => {
    const worktree = "/home/example/.no-mistakes/worktrees/a1b2c3/run-7";
    const samples = live();
    const worktreePids = new Set(samples.samples.after.filter((process) => process.folder === worktree).map((process) => process.pid));
    const predated = {
      ...samples,
      samples: {
        ...samples.samples,
        before: samples.samples.before.map((process) => (worktreePids.has(process.pid) ? { ...process, startedAtMillis: 0 } : process)),
        after: samples.samples.after.map((process) => (process.folder === worktree ? { ...process, startedAtMillis: 0 } : process)),
      },
    };
    const base = tiedSessions(paneIn(harbor, "w4D:p2"), paneIn(worktree, "w1A:p2"));
    const bridge = harborTask(taskLevels(taskReadings({ live: ok(predated), sessions: base })), "tasks-bridge-plot");
    expect(bridge.live?.processes.length).toBeGreaterThan(0);
    expect(runsWork(bridge.live)).toBe(false);
    expect(bridge.idled).toBe(false);
    expect(bridge.state).toBe("working");
  });
});

describe("a working task reads idle only when its panes tie to its folders through their agent session logs", () => {
  const till = "/home/tester/.treehouse/shop-a1b2c3/2/shop";
  const storefront = "/home/tester/my-home/projects/shop";

  const recordedTasks = (folders: ReadonlyArray<string>) =>
    decodeTasksReport(
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-10-13T20:18:16.000Z",
        orchestrator: { name: "shop", version: "0.9.0" },
        tasks: [
          {
            id: "tasks-till",
            title: "Mind the till",
            project: "shop",
            kind: "build",
            state: "working",
            detail: "",
            startedAt: "2026-10-12T15:18:16.000Z",
            firstStartedAt: "2026-10-12T15:18:16.000Z",
            endedAt: null,
            folders,
            branches: [],
          },
        ],
        overhead: [],
        schedules: [],
      }),
    );

  const tillRow = (levels: ReturnType<typeof taskLevels>) => {
    const row = levels.projects.find((project) => project.name === "shop")?.tasks.find((task) => task.id === "tasks-till");
    if (row === undefined) throw new Error("no task tasks-till");
    return row;
  };

  test("a done pane counts for the worktree its agent session log sits in, not the project folder herdr names", () => {
    const sessions = sessionViewOfQuota(fixture("quota-axi/full.json"), recordedNow);
    const levels = taskLevels(taskReadings({ tasks: recordedTasks([till]), live: undefined, sessions, now: recordedNow }));
    const row = tillRow(levels);
    expect(row.idled).toBe(true);
    expect(row.state).toBe("parked");
    expect(row.seconds).toBe(29 * 3600);
    expect(levels.projects.find((project) => project.name === "shop")?.working).toBe(0);
  });

  test("the project folder herdr names keeps running with no pane tied to it", () => {
    const sessions = sessionViewOfQuota(fixture("quota-axi/full.json"), recordedNow);
    const levels = taskLevels(taskReadings({ tasks: recordedTasks([storefront]), live: undefined, sessions, now: recordedNow }));
    const row = tillRow(levels);
    expect(row.idled).toBe(false);
    expect(row.state).toBe("working");
  });

  test("a working pane tied to a task subfolder keeps the task running", () => {
    const base = viewOf({ now: tasksNow.epochMilliseconds, weekStatus: "on_pace", weekLeft: 60 }, [], []);
    const withPresence = {
      ...base,
      panePresence: [
        { pane: "w4D:p2", status: "done", tie: harbor },
        { pane: "w1A:p2", status: "working", tie: `${harbor}/packages/schema` },
      ],
    };
    const levels = taskLevels(taskReadings({ tasks: idle29hTasks(), live: undefined, sessions: withPresence }));
    const row = idle29hRow(levels);
    expect(row.idled).toBe(false);
    expect(row.state).toBe("working");
    expect(levels.projects.find((project) => project.name === "harbor")?.working).toBe(1);
  });

  test("a headless run folder inside the task keeps its tied done pane from idling it", () => {
    const base = viewOf({ now: tasksNow.epochMilliseconds, weekStatus: "on_pace", weekLeft: 60 }, [], []);
    const withPresence = {
      ...base,
      panePresence: [{ pane: "w4D:p2", status: "done", tie: harbor }],
      headlessFolders: [{ cwd: harbor }],
    };
    const levels = taskLevels(taskReadings({ tasks: idle29hTasks(), live: undefined, sessions: withPresence }));
    const row = idle29hRow(levels);
    expect(row.idled).toBe(false);
    expect(row.state).toBe("working");
  });

  test("a failed process read on this machine keeps the task running under its tied done pane", () => {
    const base = viewOf({ now: tasksNow.epochMilliseconds, weekStatus: "on_pace", weekLeft: 60 }, [], []);
    const withoutProcesses = {
      ...base,
      processes: unreachable("processes unreadable"),
      panePresence: [{ pane: "w4D:p2", status: "done", tie: harbor }],
    };
    const levels = taskLevels(taskReadings({ tasks: idle29hTasks(), live: undefined, sessions: withoutProcesses }));
    const row = idle29hRow(levels);
    expect(row.idled).toBe(false);
    expect(row.state).toBe("working");
  });

  test("a failed process read on the remote machine keeps its task running", () => {
    const base = viewOf({ now: tasksNow.epochMilliseconds, weekStatus: "on_pace", weekLeft: 60 }, [], []);
    const remoteOf = (processes: (typeof base.processes)) => ({
      ...base,
      panePresence: [{ pane: "w4D:p2", status: "done", tie: harbor, machine: "south" }],
      composition: {
        local: "north",
        remotes: [{ name: "south", state: { kind: "ok" as const, generatedAt: tasksNow, quota: undefined, panes: undefined, processes } }],
        failedAccounts: [],
      },
    });
    const failed = taskLevels(
      taskReadings({ machine: "south", origin: "remote", tasks: idle29hTasks(), live: undefined, sessions: remoteOf(unreachable("processes unreadable")) }),
    );
    expect(idle29hRow(failed).state).toBe("working");
    expect(idle29hRow(failed).idled).toBe(false);
    const read = taskLevels(taskReadings({ machine: "south", origin: "remote", tasks: idle29hTasks(), live: undefined, sessions: remoteOf(undefined) }));
    expect(idle29hRow(read).state).toBe("parked");
    expect(idle29hRow(read).idled).toBe(true);
  });

  test("a saved sessions copy carries no presence, so its task keeps running until a live read lands", () => {
    const base = viewOf({ now: tasksNow.epochMilliseconds, weekStatus: "on_pace", weekLeft: 60 }, [], []);
    const saved = { ...base, now: tasksNow, panePresence: [{ pane: "w4D:p2", status: "done", tie: harbor }] };
    const file = Schema.toCodecJson(Schema.Struct({ value: SessionsCodec, at: Schema.Finite }));
    const raw = JSON.parse(JSON.stringify(Schema.encodeSync(file)({ value: saved, at: tasksNow.epochMilliseconds })));
    const restored = Schema.decodeUnknownSync(file)(raw);
    expect(restored.value.panePresence ?? []).toEqual([]);
    const levels = taskLevels(taskReadings({ tasks: idle29hTasks(), live: undefined, sessions: restored.value }));
    expect(idle29hRow(levels).state).toBe("working");
    expect(idle29hRow(levels).idled).toBe(false);
  });
});
