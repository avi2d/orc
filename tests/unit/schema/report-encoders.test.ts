import { describe, expect, test } from "bun:test";
import { activeRuns, decodeActions, decodePueue, decodeTasksReport, queuesReport, tasksReport } from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";

describe("the tasks report printer", () => {
  test("prints a read that reads back as the same tasks", () => {
    const read = valueOf(decodeTasksReport(fixture("tasks/east.json")));
    expect(valueOf(decodeTasksReport(JSON.stringify(tasksReport(read))))).toEqual(read);
  });

  test("prints each instant as an ISO instant and a running task's end as null", () => {
    const printed = tasksReport(valueOf(decodeTasksReport(fixture("tasks/east.json"))));
    expect(printed.generatedAt).toBe("2026-10-19T08:02:11.000Z");
    expect(printed.tasks.map(({ id, state, endedAt }) => [id, state, endedAt])).toEqual([
      ["tasks-bridge-plot", "working", null],
      ["tasks-inbox-sweep", "waiting", null],
      ["tasks-release-notes", "done", "2026-10-18T15:30:00.000Z"],
    ]);
  });
});

describe("the queues report printer", () => {
  const printed = () =>
    queuesReport({
      machines: [{ name: "north", status: decodePueue(fixture("pueue/status.json")) }],
      actions: { repo: "example/harbor", runs: activeRuns([decodeActions(fixture("github/runs-in_progress.json")), decodeActions(fixture("github/runs-queued.json"))]) },
    });

  test("prints each machine's running, ended, queued and paused tasks and its groups", () => {
    const pueue = valueOf(printed().machines[0]?.pueue ?? { kind: "invalid", issue: "no machine" });
    expect(pueue.running.map(({ id, command }) => [id, command])).toEqual([
      [5, "sleep 800"],
      [10, "sleep 1000"],
    ]);
    expect(pueue.ended.map(({ id }) => id).toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 9]);
    expect(pueue.ended.find(({ id }) => id === 0)?.result).toEqual({ kind: "exit", code: 3 });
    expect([pueue.queued, pueue.paused]).toEqual([2, 1]);
    expect(pueue.groups).toEqual([
      { name: "default", status: "Running", parallel: 1 },
      { name: "gpu", status: "Paused", parallel: 1 },
      { name: "tests", status: "Running", parallel: 2 },
    ]);
  });

  test("never prints a task's environment", () => {
    expect(JSON.stringify(printed())).not.toContain("not-a-real-token");
  });

  test("prints the active runs newest first with their status", () => {
    expect(valueOf(printed().actions.runs).map(({ status, createdAt }) => [status, createdAt])).toEqual([
      ["queued", "2026-10-18T00:20:11.000Z"],
      ["in_progress", "2026-10-18T00:12:40.000Z"],
      ["in_progress", "2026-10-18T00:05:02.000Z"],
    ]);
  });
});
