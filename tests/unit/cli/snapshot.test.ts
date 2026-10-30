import { describe, expect, test } from "bun:test";
import { Duration, Effect, Option, Ref, Schema } from "effect";
import { type SnapshotLimits, type SnapshotReaders, snapshotReport, sourcesNamed, unknownSources } from "@tui-dash/cli";
import { composedSessionQuota, composedSessionQuotaReport, SnapshotReport, type SnapshotSource, snapshotSources } from "@tui-dash/schema";
import { machineView } from "../../lib/machines-fixture";

const quickly: SnapshotLimits = {
  quota: Duration.millis(40),
  resources: Duration.millis(40),
  queues: Duration.millis(40),
  tasks: Duration.millis(40),
};

const answering: SnapshotReaders<never> = {
  quota: Effect.sync(() => ({ report: composedSessionQuotaReport(composedSessionQuota(machineView("north"), "north", []), "north") })),
  resources: Effect.succeed({ machines: [{ name: "north", reading: { kind: "unreachable", reason: "sh exited 255" } }] }),
  queues: Effect.succeed({ machines: [], actions: { repo: "example/harbor", runs: { kind: "ok", value: [] } } }),
  tasks: Effect.succeed({ machines: [] }),
};

const decodeSnapshot = Schema.decodeUnknownSync(SnapshotReport);

const taken = (readers: SnapshotReaders<never>, selected: ReadonlyArray<SnapshotSource>) =>
  Effect.runPromise(snapshotReport("north", readers, new Set(selected), quickly)).then((report) => decodeSnapshot(JSON.parse(JSON.stringify(report))));

// Oracle: the brief, where --only selects among quota, resources, queues and running tasks.
// Rejects a reader that ignores a name it does not know, so a typo would silently drop a source.
describe("the --only list", () => {
  test("names the sources to read, spaces aside", () => {
    expect(Option.map(sourcesNamed("tasks, quota"), (sources) => [...sources])).toEqual(Option.some(["tasks", "quota"]));
    expect(Option.map(sourcesNamed("quota,resources,queues,tasks"), (sources) => [...sources])).toEqual(Option.some([...snapshotSources]));
  });

  test("refuses a name that is no source, and an empty one", () => {
    expect(Option.isNone(sourcesNamed("quota,load"))).toBe(true);
    expect(Option.isNone(sourcesNamed("quota,"))).toBe(true);
    expect(unknownSources("quota,load,")).toBe('names out of quota, resources, queues, tasks, separated by commas, and "load" and an empty name are not one of them');
  });
});

// Oracle: the brief, each source has its own timeout and reports failed without blocking the call or the other sources.
// Rejects one call-wide timeout that fails every source, and a snapshot that waits on a source past its limit.
describe("the snapshot", () => {
  test("holds every source when none is left out, and decodes as the report", async () => {
    const report = await taken(answering, snapshotSources);
    expect(Object.keys(report.sources)).toEqual(["quota", "resources", "queues", "tasks"]);
    expect(report.machine).toBe("north");
    expect(Object.values(report.sources).map((answer) => answer.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(report.sources.resources).toEqual({
      status: "ok",
      machines: [{ name: "north", reading: { kind: "unreachable", reason: "sh exited 255" } }],
    });
  });

  test("reads only the sources --only names", async () => {
    const quotaReads = await Effect.runPromise(Ref.make(0));
    const counted = { ...answering, quota: Effect.andThen(Ref.update(quotaReads, (reads) => reads + 1), answering.quota) };
    const report = await taken(counted, ["tasks", "resources"]);
    expect(Object.keys(report.sources)).toEqual(["resources", "tasks"]);
    expect(await Effect.runPromise(Ref.get(quotaReads))).toBe(0);
  });

  test("reports a source that runs past its limit as failed while the others answer", async () => {
    const started = performance.now();
    const report = await taken({ ...answering, quota: Effect.never }, snapshotSources);
    expect(report.sources.quota).toEqual({ status: "failed", error: "quota gave no answer within 40ms" });
    expect([report.sources.resources?.status, report.sources.queues?.status, report.sources.tasks?.status]).toEqual(["ok", "ok", "ok"]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("reports a source stuck in a step that cannot be interrupted as failed at its limit", async () => {
    const started = performance.now();
    const report = await taken({ ...answering, quota: Effect.uninterruptible(Effect.andThen(Effect.sleep("5 seconds"), answering.quota)) }, snapshotSources);
    expect(report.sources.quota).toEqual({ status: "failed", error: "quota gave no answer within 40ms" });
    expect(report.sources.tasks).toEqual({ status: "ok", machines: [] });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("reports a source that breaks as failed with its error while the others answer", async () => {
    const report = await taken({ ...answering, queues: Effect.die(new Error("pueue state is corrupt")) }, snapshotSources);
    expect(report.sources.queues).toEqual({ status: "failed", error: "queues failed: pueue state is corrupt" });
    expect(report.sources.tasks).toEqual({ status: "ok", machines: [] });
  });
});
