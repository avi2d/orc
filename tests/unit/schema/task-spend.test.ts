import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { type CountedCall, decodeTasksReport, historyDays, type Session, taskLevels, taskSpend } from "@tui-dash/schema";
import { call, ended, fifthIn, hour, six, viewOf } from "../../lib/quota-view-fixture";

const [a, b, c, d, e] = six;

const started = DateTime.makeUnsafe(fifthIn - 24 * hour);

const task = (id: string, ...folders: ReadonlyArray<string>) => ({ id, folders, firstStartedAt: started, endedAt: null });

const tasks = [task("alpha", "/work/a", "/work/b"), task("delta", "/work/d")];

const everyLocal = () => true;

describe("taskSpend joins each task to the sessions working in its folders, only the sessions it owns, never the first model seen", () => {
  const gone = ended("z");
  const hourSpend = [46_000, 19_000, 18_000, 5000, 2000];
  const burners = [a, b, c, d, e];
  const calls: ReadonlyArray<CountedCall> = [
    ...burners.map((session, index) => call(session, fifthIn - 10 * 60_000, hourSpend[index] ?? 0)),
    call(gone, fifthIn - 30 * hour, 4_390_000),
  ];
  const ahead = () =>
    viewOf({ now: fifthIn, weekStatus: "ahead", weekLeft: 60, weekRunway: "projected_exhaustion" }, [...burners, gone], calls);

  test("a task over its fair share carries its most concerning session's ratio and the flag", () => {
    const alpha = taskSpend(ahead(), tasks, everyLocal).get("alpha");
    expect(alpha?.fair).toEqual({ account: expect.any(String), cycleSeconds: 604_800, ratio: expect.closeTo(4.6, 9), flagged: true });
    expect(alpha?.tokens).toBe(65_000);
  });

  test("a task under its share carries its ratio unflagged, and a session in no task's folder counts for none", () => {
    const spend = taskSpend(ahead(), tasks, everyLocal);
    expect(spend.get("delta")?.fair).toEqual({ account: expect.any(String), cycleSeconds: 604_800, ratio: expect.closeTo(0.5, 9), flagged: false });
    expect([...spend.keys()].toSorted()).toEqual(["alpha", "delta"]);
  });

  test("a limit on pace gives no ratio", () => {
    const onPace = viewOf({ now: fifthIn, weekStatus: "on_pace", weekLeft: 60 }, [...burners, gone], calls);
    expect(taskSpend(onPace, tasks, everyLocal).get("alpha")?.fair).toBeUndefined();
  });

  test("names the model with the most tokens since midnight across the task's sessions", () => {
    const sonnet = (session: Session, input: number): CountedCall => ({ ...call(session, fifthIn - 2 * hour, input), model: "claude-sonnet-5-5" });
    const mixed = [call(a, fifthIn - 10 * 60_000, 3000), sonnet(a, 2000), sonnet(b, 2000)];
    const view = viewOf({ now: fifthIn, weekStatus: "on_pace", weekLeft: 60 }, burners, mixed);
    expect(taskSpend(view, tasks, everyLocal).get("alpha")).toMatchObject({ model: "claude-sonnet-5-5", tokens: 7000 });
  });

  test("a Muse-model session billed to opencode-go carries opencode-go's provider", () => {
    const muse = { ...call(a, fifthIn - 2 * hour, 3000), quota: "opencode-go" as const, model: "muse-spark-1.3-contributor" };
    const view = viewOf({ now: fifthIn, weekStatus: "on_pace", weekLeft: 60 }, [a], [muse]);
    expect(taskSpend(view, tasks, everyLocal).get("alpha")).toMatchObject({ model: "muse-spark-1.3-contributor", provider: "opencode-go" });
  });

  test("a model billed to two providers carries the one that billed today tokens", () => {
    const billed = [
      { ...call(a, fifthIn - 26 * hour, 9000), model: "muse-spark-1.3-contributor" },
      { ...call(a, fifthIn - 2 * hour, 3000), quota: "opencode-go" as const, route: "opencode-go", model: "muse-spark-1.3-contributor" },
    ];
    const view = viewOf({ now: fifthIn, weekStatus: "on_pace", weekLeft: 60 }, [a], billed);
    expect(taskSpend(view, tasks, everyLocal).get("alpha")).toMatchObject({
      model: "muse-spark-1.3-contributor",
      tokens: 3000,
      provider: "opencode-go",
    });
  });

  test("a session no window holds carries no provider", () => {
    const stray = { ...call(a, fifthIn - 2 * hour, 3000), quota: undefined };
    const view = viewOf({ now: fifthIn, weekStatus: "on_pace", weekLeft: 60 }, [a], [stray]);
    expect(taskSpend(view, tasks, everyLocal).get("alpha")).toMatchObject({ model: "claude-opus-5-5", provider: undefined });
  });

  test("a session that spent nothing since midnight and in the last hour gives its task no line", () => {
    const spend = taskSpend(ahead(), [...tasks, task("zed", "/work/z")], everyLocal);
    expect(spend.has("zed")).toBe(false);
  });

  test("leaves out the sessions on another machine", () => {
    const spend = taskSpend(ahead(), tasks, (session) => session.id !== "pane:d");
    expect(spend.has("delta")).toBe(false);
  });
});

describe("taskSpend over a pool folder, joined by the session's own time and not the time of the read", () => {
  test("gives a session to the task that held its folder when the session first called today", () => {
    const before = { id: "before", folders: ["/work/a"], firstStartedAt: started, endedAt: DateTime.makeUnsafe(fifthIn - hour) };
    const after = { id: "after", folders: ["/work/a"], firstStartedAt: DateTime.makeUnsafe(fifthIn - hour / 2), endedAt: null };
    const view = viewOf({ now: fifthIn, weekStatus: "on_pace", weekLeft: 60 }, [a], [call(a, fifthIn - 2 * hour, 3000)]);
    const spend = taskSpend(view, [before, after], everyLocal);
    expect([...spend.keys()]).toEqual(["before"]);
  });
});

describe("task levels beside an untagged session in the same folder, and the other machine's task never takes this machine's tokens", () => {
  const report = decodeTasksReport(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: DateTime.formatIso(DateTime.makeUnsafe(fifthIn)),
      orchestrator: { name: "kelp-farmer", version: "0.9.0" },
      tasks: [
        {
          id: "alpha",
          title: "Alpha",
          project: "work",
          kind: "build",
          state: "working",
          detail: "Working",
          startedAt: DateTime.formatIso(started),
          firstStartedAt: DateTime.formatIso(started),
          endedAt: null,
          folders: ["/work/a"],
          branches: [],
        },
      ],
      overhead: [],
      schedules: [],
    }),
  );
  const view = viewOf({ now: fifthIn, weekStatus: "on_pace", weekLeft: 60 }, [a], [call(a, fifthIn - 2 * hour, 3000)]);
  const spendOf = (machine: string, origin: "local" | "remote") =>
    taskLevels({
      machine,
      origin,
      tasks: report,
      samples: [],
      live: undefined,
      liveConfigured: origin === "local",
      pueue: undefined,
      noMistakes: undefined,
      orc: undefined,
      sessions: view,
      now: DateTime.makeUnsafe(fifthIn),
      days: historyDays,
      zone: DateTime.zoneMakeNamedUnsafe("UTC"),
    }).projects.flatMap((project) => project.tasks.map((row) => row.spend?.tokens));

  test("gives the session to this machine's task and none to the other machine's", () => {
    expect([spendOf("north", "local"), spendOf("south", "remote")]).toEqual([[3000], [undefined]]);
  });
});

describe("taskSpend beside a remote session of the same id, which never replaces the local first call", () => {
  test("joins the local session by its own first call", () => {
    const before = { id: "before", folders: ["/work/a"], firstStartedAt: started, endedAt: DateTime.makeUnsafe(fifthIn - hour) };
    const after = { id: "after", folders: ["/work/a"], firstStartedAt: DateTime.makeUnsafe(fifthIn - hour / 2), endedAt: null };
    const local = viewOf({ now: fifthIn, weekStatus: "on_pace", weekLeft: 60 }, [a], [call(a, fifthIn - 2 * hour, 3000)]);
    const remote = { ...a, machine: "south" };
    const remoteModels = local.modelsSinceMidnight.map((entry) => ({ ...entry, session: remote, firstCallAt: undefined }));
    const view = { ...local, sessions: [...local.sessions, remote], modelsSinceMidnight: [...local.modelsSinceMidnight, ...remoteModels] };
    const spend = taskSpend(view, [before, after], (session) => session.machine === undefined);
    expect([...spend.keys()]).toEqual(["before"]);
  });
});
