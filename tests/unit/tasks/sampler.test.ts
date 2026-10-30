import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";
import {
  decodeLinuxTaskProcesses,
  decodeMacTaskProcesses,
  decodeTasksReport,
  encodeTaskSample,
  historyDays,
  keptCpuSeconds,
  type OwnedProcess,
  ownedProcesses,
  type SampledSpend,
  type SampledTestRun,
  taskHistories,
  taskLevels,
  type TaskSampleRecord,
  taskSampleRecords,
  ok,
} from "@tui-dash/schema";
import { sampleRecords, spendLines, ticketLines, type WrittenLine, writtenOf } from "@tui-dash/tasks";
import { plain } from "@tui-dash/ui";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";
import { taskReadings } from "../../lib/task-levels-fixture";

const tasks = valueOf(decodeTasksReport(fixture("tasks/east.json"))).view.tasks;

const machine = { cores: 16, memoryBytes: 48 * 1024 ** 3 };

const minute = (index: number) => DateTime.makeUnsafe(Date.parse("2026-10-19T08:00:00Z") + index * 60_000);

const bridgeUsing = (ownSeconds: number, cpuCores = 1.5): ReadonlyArray<OwnedProcess> => [
  { task: "tasks-bridge-plot", folder: "/home/example/work/harbor", pid: 2100, identity: "boot 2100 8100000", parent: undefined, ownSeconds, waitedChildSeconds: 0, cpuCores, residentBytes: 1024 ** 3 },
];

const rounds = (usage: ReadonlyArray<ReadonlyArray<OwnedProcess>>): ReadonlyArray<TaskSampleRecord> => {
  let written: ReadonlyMap<string, WrittenLine> = new Map();
  return usage.flatMap((used, index) => {
    const round = sampleRecords(tasks, used, {}, machine, minute(index), written);
    written = round.written;
    return round.records;
  });
};

const bridgeLines = (records: ReadonlyArray<TaskSampleRecord>) =>
  records.filter((record) => record.task.id === "tasks-bridge-plot").map((record) => record.usage?.processes[0]?.ownSeconds ?? null);

describe("the sampler's records", () => {
  test("the first round writes every listed task, with usage only for the task that has processes", () => {
    const first = sampleRecords(tasks, bridgeUsing(100), {}, machine, minute(0), new Map()).records;
    expect(first.map((record) => [record.task.id, record.usage?.processes.map((process) => process.ownSeconds) ?? null])).toEqual([
      ["tasks-bridge-plot", [100]],
      ["tasks-inbox-sweep", null],
      ["tasks-release-notes", null],
    ]);
    expect(first.every((record) => record.machine === machine)).toBe(true);
  });

  test("later rounds write the task with processes and leave the idle ones out while the report says the same of them", () => {
    const records = rounds([bridgeUsing(100), bridgeUsing(115), bridgeUsing(130)]);
    expect(records.slice(3).map((record) => record.task.id)).toEqual(["tasks-bridge-plot", "tasks-bridge-plot"]);
    const kept = taskHistories(records, minute(2), historyDays).get("tasks-bridge-plot");
    expect([...(kept?.processes.values() ?? [])].map((process) => process.ownSeconds)).toEqual([130]);
  });

  test("an idle task is written again when the report says something new of it", () => {
    const first = sampleRecords(tasks, [], {}, machine, minute(0), new Map());
    const parked = tasks.map((task) => (task.id === "tasks-inbox-sweep" ? { ...task, state: "parked" as const } : task));
    expect(sampleRecords(parked, [], {}, machine, minute(1), first.written).records.map((record) => [record.task.id, record.task.state])).toEqual([
      ["tasks-inbox-sweep", "parked"],
    ]);
  });

  test("an idle task is written again when its detail changes, and the line keeps the detail", () => {
    const first = sampleRecords(tasks, [], {}, machine, minute(0), new Map());
    const moved = tasks.map((task) => (task.id === "tasks-inbox-sweep" ? { ...task, detail: "CI · 1 of 5 checks passed" } : task));
    const records = sampleRecords(moved, [], {}, machine, minute(1), first.written).records;
    expect(records.map((record) => [record.task.id, record.task.detail])).toEqual([["tasks-inbox-sweep", "CI · 1 of 5 checks passed"]]);
    const written = records.at(0);
    if (written === undefined) throw new Error("no line written");
    expect(taskSampleRecords(Effect.runSync(encodeTaskSample(written)))[0]?.task.detail).toBe("CI · 1 of 5 checks passed");
  });

  test("an idle task is written again when its observed orc stage changes, and the line keeps the stage", () => {
    const staged = (stage: string | undefined) => ({
      orcStages: stage === undefined ? undefined : new Map([["tasks-inbox-sweep", stage]]),
    });
    const first = sampleRecords(tasks, [], staged("agent"), machine, minute(0), new Map());
    expect(first.records.map((record) => [record.task.id, record.orcStage])).toEqual([
      ["tasks-bridge-plot", undefined],
      ["tasks-inbox-sweep", "agent"],
      ["tasks-release-notes", undefined],
    ]);
    expect(sampleRecords(tasks, [], staged("agent"), machine, minute(1), first.written).records).toEqual([]);
    const moved = sampleRecords(tasks, [], staged("checks"), machine, minute(2), first.written);
    expect(moved.records.map((record) => [record.task.id, record.orcStage])).toEqual([["tasks-inbox-sweep", "checks"]]);
    const written = moved.records.at(0);
    if (written === undefined) throw new Error("no line written");
    expect(taskSampleRecords(Effect.runSync(encodeTaskSample(written)))[0]?.orcStage).toBe("checks");
  });

  test("an idle orc task keeps its observed stage and its original start across pruning and a restart", () => {
    const day = (index: number) => DateTime.makeUnsafe(Date.parse("2026-10-19T08:00:00Z") + index * 86_400_000);
    const staged = { orcStages: new Map([["tasks-inbox-sweep", "agent"]]) };
    const starts = (records: ReadonlyArray<TaskSampleRecord>) =>
      records.map((record) => (record.orcStageSince === undefined ? undefined : DateTime.toEpochMillis(record.orcStageSince)));
    const all: Array<TaskSampleRecord> = [];
    const sweepLines: Array<TaskSampleRecord> = [];
    let written: ReadonlyMap<string, WrittenLine> = new Map();
    const round = (index: number) => {
      const sampled = sampleRecords(tasks, [], staged, machine, day(index), written);
      written = sampled.written;
      all.push(...sampled.records);
      const sweep = sampled.records.filter((record) => record.task.id === "tasks-inbox-sweep");
      sweepLines.push(...sweep);
      return sweep;
    };
    expect(round(0).map((record) => record.orcStage)).toEqual(["agent"]);
    expect(starts(sweepLines)).toEqual([DateTime.toEpochMillis(day(0))]);
    expect(round(1)).toEqual([]);
    expect(round(2)).toEqual([]);
    expect(round(3)).toEqual([]);
    expect(round(4).map((record) => record.orcStage)).toEqual(["agent"]);
    expect(round(8).map((record) => record.orcStage)).toEqual(["agent"]);
    expect(starts(sweepLines.slice(1))).toEqual([DateTime.toEpochMillis(day(0)), DateTime.toEpochMillis(day(0))]);
    const recovered = writtenOf(all).get("tasks-inbox-sweep");
    expect(recovered?.orcStage).toBe("agent");
    expect(recovered?.orcStageSinceMillis).toBe(DateTime.toEpochMillis(day(0)));
    const pruned = all.filter((record) => DateTime.toEpochMillis(record.at) >= DateTime.toEpochMillis(day(1)));
    const repruned = writtenOf(pruned).get("tasks-inbox-sweep");
    expect(repruned?.orcStage).toBe("agent");
    expect(repruned?.orcStageSinceMillis).toBe(DateTime.toEpochMillis(day(0)));
    const line = sweepLines.at(-1);
    if (line === undefined) throw new Error("no line written");
    const back = taskSampleRecords(Effect.runSync(encodeTaskSample(line)));
    expect(back[0]?.orcStage).toBe("agent");
    expect(back[0]?.orcStageSince).toEqual(day(0));
  });

  test("a done task is written again with the new dates a report gives it", () => {
    const first = sampleRecords(tasks, [], {}, machine, minute(0), new Map());
    const redated = tasks.map((task) => (task.state === "done" ? { ...task, endedAt: minute(1) } : task));
    expect(sampleRecords(redated, [], {}, machine, minute(1), first.written).records.map((record) => [record.task.id, record.task.endedAt])).toEqual([
      ["tasks-release-notes", minute(1)],
    ]);
  });
});

describe("the sampler when a task's processes end", () => {
  test("writes one line with no usage, and none for the idle minutes after it", () => {
    const busy = bridgeUsing(100, 12);
    const records = rounds([...Array.from({ length: 10 }, () => busy), [], [], busy]);
    expect(bridgeLines(records)).toEqual([...Array.from({ length: 10 }, () => 100), null, 100]);
    expect(taskHistories(records, minute(12), historyDays).get("tasks-bridge-plot")?.episodes).toEqual([]);
  });
});

describe("the sampler after a restart", () => {
  test("goes on from the ledger, writing only what changed since its last line of each task", () => {
    const before = rounds([bridgeUsing(100)]);
    const after = sampleRecords(tasks, [], {}, machine, minute(30), writtenOf(before)).records;
    expect(after.map((record) => [record.task.id, record.usage])).toEqual([["tasks-bridge-plot", null]]);
  });
});

const statLine = (pid: number, ppid: number, ownTicks: number, childTicks: number, startTicks = 8100000) =>
  String(pid) + " (task) S " + String(ppid) + " 1 1 0 -1 0 0 0 0 0 " + String(ownTicks) + " 0 " + String(childTicks) + " 0 20 0 1 0 " + String(startTicks) + " 0 0 0";

const listed = (stats: ReadonlyArray<string>, header: { readonly btime?: number; readonly boot?: string } = {}) =>
  [
    "pagesize 4096",
    "ticks 100",
    "btime " + String(header.btime ?? 1792281600),
    "boot " + (header.boot ?? "4f6d2a9e-1c3b-4e8a-9d7f-2b5c8e0a1d34"),
    "uptime 1.00",
    ...stats,
    "uptime 2.00",
    ...stats,
    ...stats.map((stat) => "cwd /proc/" + (stat.split(" ")[0] ?? "") + " /home/example/work/harbor"),
  ].join("\n");

const macListed = (ownSeconds: number, childSeconds: number) => {
  const sample = (at: string) => [
    "at " + at,
    " 2100     1  1024   0:00.00   0:00.00 Sun Oct 18 22:30:00 2026",
    "rusage 2100 " + String(ownSeconds) + " " + String(childSeconds),
  ];
  return [...sample("100.0"), ...sample("101.0"), "p2100", "fcwd", "n/home/example/work/harbor"].join("\n");
};

const keptFrom = (listings: ReadonlyArray<string>, decode = decodeLinuxTaskProcesses): number => {
  let written: ReadonlyMap<string, WrittenLine> = new Map();
  const records = listings.flatMap((text, index) => {
    const round = sampleRecords(tasks, ownedProcesses(tasks, valueOf(decode(text))), {}, machine, minute(index), written);
    written = round.written;
    return round.records;
  });
  const kept = taskHistories(records, minute(listings.length), historyDays).get("tasks-bridge-plot");
  return keptCpuSeconds(kept?.processes ?? new Map());
};

// proc(5) puts a waited-for child's time in cutime and cstime.
describe("the sampler over the processes of a task", () => {
  test("counts a waited-for child once, with the time it used after its last sample", () => {
    const first = listed([statLine(2100, 1, 10000, 0), statLine(2200, 2100, 5000, 0)]);
    const second = listed([statLine(2100, 1, 10500, 6000)]);
    expect(keptFrom([first, second])).toBeCloseTo(165, 9);
  });

  test("counts a child too short to fall in a sample in the parent that waited for it", () => {
    const first = listed([statLine(2100, 1, 10000, 0)]);
    const second = listed([statLine(2100, 1, 10500, 3000)]);
    expect(keptFrom([first, second])).toBeCloseTo(135, 9);
  });

  test("on the Mac counts a child too short to fall in a sample in the rusage child time of the parent that waited for it", () => {
    expect(keptFrom([macListed(100, 0), macListed(105, 30)], decodeMacTaskProcesses)).toBeCloseTo(135, 9);
  });

  // A pid is reused, so a process is its pid, starttime in ticks since boot, and the boot id.
  test("keeps a process the same across a clock step, and takes the same pid and start after a reboot for another", () => {
    const stepped = [listed([statLine(2100, 1, 10000, 0)]), listed([statLine(2100, 1, 10500, 0)], { btime: 1792281605 })];
    expect(keptFrom(stepped)).toBeCloseTo(105, 9);
    const rebooted = [listed([statLine(2100, 1, 10000, 0)]), listed([statLine(2100, 1, 500, 0)], { boot: "0a1b2c3d-0000-4000-8000-000000000000" })];
    expect(keptFrom(rebooted)).toBeCloseTo(105, 9);
  });
});

const opusSpend: SampledSpend = { model: "opus", tokens: 1200, outputTokens: 300, fair: null };

const bunTest: SampledTestRun = {
  id: 7,
  command: "bun test",
  path: "/home/example/work/harbor",
  startedAt: minute(0),
  endedAt: DateTime.add(minute(0), { seconds: 90 }),
  result: { kind: "success" },
};

const bridgeDetailOf = (spend: SampledSpend, tests: ReadonlyArray<SampledTestRun>) => ({
  spend: new Map([["tasks-bridge-plot", spend] as const]),
  tests: new Map([["tasks-bridge-plot", tests] as const]),
});

const bridgeRecordOf = (records: ReadonlyArray<TaskSampleRecord>): TaskSampleRecord => {
  const record = records.find((line) => line.task.id === "tasks-bridge-plot");
  if (record === undefined) throw new Error("no line for tasks-bridge-plot");
  return record;
};

describe("the sampler's detail", () => {
  test("a round's line keeps the task's spend and test runs", () => {
    const records = sampleRecords(tasks, bridgeUsing(100), bridgeDetailOf(opusSpend, [bunTest]), machine, minute(0), new Map()).records;
    expect(bridgeRecordOf(records).spend).toEqual(opusSpend);
    expect(bridgeRecordOf(records).tests).toEqual([bunTest]);
  });

  test("an idle task is written again when its test runs change, and a new model writes one too", () => {
    const first = sampleRecords(tasks, [], bridgeDetailOf(opusSpend, []), machine, minute(0), new Map());
    const rerun = sampleRecords(tasks, [], bridgeDetailOf(opusSpend, [bunTest]), machine, minute(1), first.written);
    expect(rerun.records.map((record) => [record.task.id, record.tests?.length ?? 0])).toEqual([["tasks-bridge-plot", 1]]);
    const renamed = sampleRecords(tasks, [], bridgeDetailOf({ ...opusSpend, model: "sonnet" }, [bunTest]), machine, minute(2), rerun.written);
    expect(renamed.records.map((record) => [record.task.id, record.spend?.model])).toEqual([["tasks-bridge-plot", "sonnet"]]);
    expect("tests" in bridgeRecordOf(renamed.records)).toBe(false);
  });

  test("spend tokens riding along do not write an idle task again", () => {
    const first = sampleRecords(tasks, [], bridgeDetailOf(opusSpend, []), machine, minute(0), new Map());
    const richer = sampleRecords(tasks, [], bridgeDetailOf({ ...opusSpend, tokens: 2400 }, []), machine, minute(1), first.written);
    expect(richer.records).toEqual([]);
  });

  test("a source that failed to read omits each task's last detail from the line and keeps it in memory", () => {
    const first = sampleRecords(tasks, bridgeUsing(100), bridgeDetailOf(opusSpend, [bunTest]), machine, minute(0), new Map());
    const blind = sampleRecords(tasks, bridgeUsing(115), { spend: undefined, tests: undefined }, machine, minute(1), first.written);
    expect("spend" in bridgeRecordOf(blind.records)).toBe(false);
    expect("tests" in bridgeRecordOf(blind.records)).toBe(false);
    const idle = sampleRecords(tasks, [], { spend: undefined, tests: undefined }, machine, minute(2), blind.written);
    expect(idle.records.map((record) => record.task.id)).toEqual(["tasks-bridge-plot"]);
    expect("spend" in bridgeRecordOf(idle.records)).toBe(false);
    expect("tests" in bridgeRecordOf(idle.records)).toBe(false);
    const history = taskHistories([...first.records, ...blind.records, ...idle.records], minute(2), historyDays).get("tasks-bridge-plot");
    expect(history?.spend?.model).toBe("opus");
    expect(history?.tests.map((run) => run.command)).toEqual(["bun test"]);
  });

  // Lines carry spend and tests only when they changed: the whole test-run array each minute is about 9 KB on a busy task.
  test("a busy task's lines carry tests and spend only when they changed", () => {
    const first = sampleRecords(tasks, bridgeUsing(100), bridgeDetailOf(opusSpend, [bunTest]), machine, minute(0), new Map());
    expect(bridgeRecordOf(first.records).tests).toEqual([bunTest]);
    expect(bridgeRecordOf(first.records).spend).toEqual(opusSpend);
    const second = sampleRecords(tasks, bridgeUsing(115), bridgeDetailOf(opusSpend, [bunTest]), machine, minute(1), first.written);
    const line = bridgeRecordOf(second.records);
    expect(line.usage).not.toBeNull();
    expect("spend" in line).toBe(false);
    expect("tests" in line).toBe(false);
    expect(JSON.stringify(line).length).toBeLessThan(1000);
    const history = taskHistories([...first.records, ...second.records], minute(1), historyDays).get("tasks-bridge-plot");
    expect(history?.spend?.model).toBe("opus");
    expect(history?.tests.map((run) => run.command)).toEqual(["bun test"]);
  });

  test("new spend tokens write the spend again but leave the test runs out", () => {
    const first = sampleRecords(tasks, bridgeUsing(100), bridgeDetailOf(opusSpend, [bunTest]), machine, minute(0), new Map());
    const richer = sampleRecords(tasks, bridgeUsing(115), bridgeDetailOf({ ...opusSpend, tokens: 2400 }, [bunTest]), machine, minute(1), first.written);
    const line = bridgeRecordOf(richer.records);
    expect(line.spend?.tokens).toBe(2400);
    expect("tests" in line).toBe(false);
    const history = taskHistories([...first.records, ...richer.records], minute(1), historyDays).get("tasks-bridge-plot");
    expect(history?.spend?.tokens).toBe(2400);
    expect(history?.tests.map((run) => run.command)).toEqual(["bun test"]);
  });

  test("an unchanged task is rewritten before its carrying line leaves the span", () => {
    const flaggedSpend: SampledSpend = { model: "opus", tokens: 1200, outputTokens: 300, fair: { account: "main", cycleSeconds: 3600, ratio: 0.5, flagged: true } };
    const flaggedDetail = bridgeDetailOf(flaggedSpend, [bunTest]);
    const first = sampleRecords(tasks, [], flaggedDetail, machine, minute(0), new Map());
    expect(bridgeRecordOf(first.records).spend).toEqual(flaggedSpend);
    const halfMinutes = (historyDays * 24 * 60) / 2 + 1;
    const second = sampleRecords(tasks, [], flaggedDetail, machine, minute(halfMinutes), first.written);
    const keyframe = bridgeRecordOf(second.records);
    expect(keyframe.spend).toEqual(flaggedSpend);
    expect(keyframe.tests).toEqual([bunTest]);
    const spanMinutes = historyDays * 24 * 60 + 1;
    const third = sampleRecords(tasks, [], flaggedDetail, machine, minute(spanMinutes), second.written);
    expect(third.records.map((record) => record.task.id)).toContain("tasks-bridge-plot");
    expect(taskHistories(first.records, minute(spanMinutes), historyDays).get("tasks-bridge-plot")).toBeUndefined();
    const history = taskHistories([...first.records, ...second.records, ...third.records], minute(spanMinutes), historyDays).get("tasks-bridge-plot");
    expect(history?.spend?.model).toBe("opus");
    expect(history?.spend?.tokens).toBe(1200);
    expect(history?.spend?.fair?.flagged).toBe(true);
    expect(history?.tests.map((run) => run.command)).toEqual(["bun test"]);
  });

  test("a finished task removed from the report keeps its detail past one span", () => {
    const flaggedSpend: SampledSpend = { model: "opus", tokens: 1200, outputTokens: 300, fair: { account: "main", cycleSeconds: 3600, ratio: 0.5, flagged: true } };
    const flaggedDetail = bridgeDetailOf(flaggedSpend, [bunTest]);
    const first = sampleRecords(tasks, [], flaggedDetail, machine, minute(0), new Map());
    const finishedAt = 120;
    const finishedTasks = tasks.map((task) =>
      task.id === "tasks-bridge-plot" ? { ...task, state: "done" as const, endedAt: minute(finishedAt) } : task,
    );
    const finished = sampleRecords(finishedTasks, [], flaggedDetail, machine, minute(finishedAt), first.written);
    const closing = bridgeRecordOf(finished.records);
    expect(closing.spend).toEqual(flaggedSpend);
    expect(closing.tests).toEqual([bunTest]);
    const goneAt = finishedAt + 1;
    const gone = tasks.filter((task) => task.id !== "tasks-bridge-plot");
    const vanished = sampleRecords(gone, [], {}, machine, minute(goneAt), finished.written);
    const terminal = bridgeRecordOf(vanished.records);
    expect(terminal.usage).toBeNull();
    expect(terminal.spend).toEqual(flaggedSpend);
    expect(terminal.tests).toEqual([bunTest]);
    const spanMinutes = historyDays * 24 * 60;
    const nowMinutes = goneAt + spanMinutes;
    const now = minute(nowMinutes);
    expect(taskHistories(first.records, now, historyDays).get("tasks-bridge-plot")).toBeUndefined();
    expect(taskHistories([...first.records, ...finished.records], now, historyDays).get("tasks-bridge-plot")).toBeUndefined();
    const history = taskHistories([...first.records, ...finished.records, ...vanished.records], now, historyDays).get("tasks-bridge-plot");
    expect(history?.spend?.model).toBe("opus");
    expect(history?.spend?.tokens).toBe(1200);
    expect(history?.spend?.fair?.flagged).toBe(true);
    expect(history?.tests.map((run) => run.command)).toEqual(["bun test"]);
  });

  test("a restart never listed since startup writes no snapshot for the absent task", () => {
    const flaggedSpend: SampledSpend = { model: "opus", tokens: 1200, outputTokens: 300, fair: { account: "main", cycleSeconds: 3600, ratio: 0.5, flagged: true } };
    const live = sampleRecords(tasks, [], bridgeDetailOf(flaggedSpend, [bunTest]), machine, minute(0), new Map());
    const gone = tasks.filter((task) => task.id !== "tasks-bridge-plot");
    const vanished = sampleRecords(gone, [], {}, machine, minute(1), live.written);
    expect(bridgeRecordOf(vanished.records).spend).toEqual(flaggedSpend);
    const encoded = [...live.records, ...vanished.records].map((record) => Effect.runSync(encodeTaskSample(record)));
    const read = taskSampleRecords(encoded.join("\n"));
    const afterRestart = sampleRecords(gone, [], {}, machine, minute(24 * 60), writtenOf(read));
    expect(afterRestart.records.filter((record) => record.task.id === "tasks-bridge-plot")).toEqual([]);
    expect(taskHistories(read, minute(24 * 60), historyDays).get("tasks-bridge-plot")?.spend?.model).toBe("opus");
  });

  test("a restart recovers detail from delta lines and writes only the closing line", () => {
    const first = sampleRecords(tasks, bridgeUsing(100), bridgeDetailOf(opusSpend, [bunTest]), machine, minute(0), new Map());
    const second = sampleRecords(tasks, bridgeUsing(115), bridgeDetailOf(opusSpend, [bunTest]), machine, minute(1), first.written);
    const encoded = [...first.records, ...second.records].map((record) => Effect.runSync(encodeTaskSample(record)));
    expect(encoded.slice(1).every((line) => !line.includes("bun test"))).toBe(true);
    const read = taskSampleRecords(encoded.join("\n"));
    const after = sampleRecords(tasks, [], {}, machine, minute(2), writtenOf(read));
    expect(after.records.map((record) => record.task.id)).toEqual(["tasks-bridge-plot"]);
    expect("tests" in bridgeRecordOf(after.records)).toBe(false);
    const history = taskHistories([...read, ...after.records], minute(2), historyDays).get("tasks-bridge-plot");
    expect(history?.spend?.model).toBe("opus");
    expect(history?.tests.map((run) => run.command)).toEqual(["bun test"]);
  });
});

describe("a finished task keeps its model line and test runs", () => {
  test("live in one sample and gone in the next still renders both from history", () => {
    const live = sampleRecords(tasks, bridgeUsing(100), bridgeDetailOf(opusSpend, [bunTest]), machine, minute(0), new Map());
    const gone = tasks.filter((task) => task.id !== "tasks-bridge-plot");
    const next = sampleRecords(gone, [], {}, machine, minute(1), live.written);
    const report = valueOf(decodeTasksReport(fixture("tasks/east.json")));
    const unlisted = { ...report, view: { ...report.view, tasks: report.view.tasks.filter((task) => task.id !== "tasks-bridge-plot") } };
    const levels = taskLevels(taskReadings({ tasks: ok(unlisted), samples: [...live.records, ...next.records] }));
    const row = levels.projects.flatMap((project) => project.tasks).find((task) => task.id === "tasks-bridge-plot");
    if (row === undefined) throw new Error("no history row for tasks-bridge-plot");
    expect(row.spend?.model).toBe("opus");
    expect(row.tests.map((run) => run.command)).toEqual(["bun test"]);
    expect(row.testSeconds).toBe(90);
    expect(spendLines(row, 80).map(plain).join("\n")).toContain("1k tok");
    expect(ticketLines(row, { machine: "north", source: "local", listed: true, usageRead: false }, levels.now, DateTime.zoneMakeNamedUnsafe("UTC"), 80).map(plain).join("\n")).toContain("Opus");
  });
});

describe("a task the adapter still lists shows only its live detail", () => {
  test("its sampled model line and test runs stay out of its row", () => {
    const sampled = sampleRecords(tasks, bridgeUsing(100), bridgeDetailOf(opusSpend, [bunTest]), machine, minute(0), new Map());
    const emptyQueue = ok({ groups: { default: { status: "Running" as const, parallel_tasks: 1 } }, tasks: {} });
    const levels = taskLevels(taskReadings({ samples: sampled.records, pueue: emptyQueue, sessions: undefined }));
    const row = levels.projects.flatMap((project) => project.tasks).find((task) => task.id === "tasks-bridge-plot");
    if (row === undefined) throw new Error("no row for tasks-bridge-plot");
    expect(row.spend).toBeUndefined();
    expect(row.tests).toEqual([]);
    expect(row.testSeconds).toBeUndefined();
  });
});
