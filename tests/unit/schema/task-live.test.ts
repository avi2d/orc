import { describe, expect, test } from "bun:test";
import {
  decodeLinuxTaskProcesses,
  decodeLiveTasksReport,
  type LiveTasks,
  liveTasksReport,
  ok,
} from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { issueOf, valueOf } from "../../lib/outcomes";
import { gib, live, tasksNow } from "../../lib/task-levels-fixture";

describe("the live tasks report, every process, program name and byte kept, and the sample interval unchanged", () => {
  const read = (): LiveTasks => ({
    samples: valueOf(decodeLinuxTaskProcesses(fixture("linux/task-processes.txt"))),
    programs: new Map([
      [2100, "pi"],
      [2200, "bun"],
    ]),
    memoryBytes: 47 * gib,
  });

  test("prints a live reading that reads back as the same reading", () => {
    const printed = JSON.stringify(liveTasksReport({ generatedAt: tasksNow, live: ok(read()) }));
    expect(decodeLiveTasksReport(printed)).toEqual(ok(read()));
  });

  test("prints the recorded reading with its interval, programs and memory intact", () => {
    const printed = JSON.stringify(liveTasksReport({ generatedAt: tasksNow, live: ok(live()) }));
    const reread = valueOf(decodeLiveTasksReport(printed));
    expect([reread.samples.intervalSeconds, reread.programs.get(2100), reread.memoryBytes]).toEqual([
      valueOf(decodeLinuxTaskProcesses(fixture("linux/task-processes.txt"))).intervalSeconds,
      "pi",
      47 * gib,
    ]);
  });

  test("keeps a failed read failed instead of clearing it", () => {
    for (const failed of [
      { kind: "unreachable", reason: "sh exited 255: ssh: connect to host south: Connection refused" },
      { kind: "invalid", issue: "line 1 does not read as a page size" },
    ] as const) {
      const printed = JSON.stringify(liveTasksReport({ generatedAt: tasksNow, live: failed }));
      expect(decodeLiveTasksReport(printed)).toEqual(failed);
    }
  });

  test("rejects output that is not a live report", () => {
    expect(issueOf(decodeLiveTasksReport("not json"))).toContain("not JSON");
    expect(
      issueOf(
        decodeLiveTasksReport(JSON.stringify({ schemaVersion: 1, generatedAt: "2026-10-19T08:02:11.000Z", live: { kind: "ok", value: {} } })),
      ),
    ).toContain("live");
  });
});
