import { describe, expect, test } from "bun:test";
import { ConfigProvider, DateTime, Duration, Effect, Layer } from "effect";
import {
  type Command,
  CommandRunner,
  CommandUnreachable,
  decodeComputeApps,
  decodeCpuUsage,
  decodeDf,
  decodeGpus,
  decodeLinuxProcesses,
  decodeLoadavg,
  decodeMeminfo,
  decodeOnlineCpus,
  decodeResourcesReport,
  machinesView,
  ok,
  ResourceMachines,
  resourceMachinesLayer,
  resourcesReport,
  resourcesView,
} from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { issueOf, valueOf } from "../../lib/outcomes";

const gib = 1024 ** 3;

const capturedAt = DateTime.makeUnsafe("2026-10-13T20:18:16Z");

const southReport = () => fixture("resources/south.json");

const edited = (edit: (report: Record<string, unknown>) => Record<string, unknown>): string => {
  const parsed: unknown = JSON.parse(southReport());
  if (typeof parsed !== "object" || parsed === null) throw new Error("the south fixture is not an object");
  return JSON.stringify(edit({ ...parsed }));
};

describe("the resources report reader", () => {
  test("reads every figure of the other machine's report", () => {
    const { generatedAt, view } = valueOf(decodeResourcesReport(southReport()));
    expect(DateTime.formatIso(generatedAt)).toBe("2026-10-13T20:18:10.000Z");
    expect(view.machine).toEqual({
      cpu: ok({ percent: 42.4, cores: 16 }),
      memory: ok({ usedBytes: 12 * gib, totalBytes: 64 * gib }),
      disk: ok({ usedBytes: 207120975424, totalBytes: 1081101178432 }),
      load: ok([3.5, 2.25, 1.75]),
      processes: ok([
        { pid: 4242, program: "trainer", cpuPercent: 37.5, residentBytes: 2 * gib },
        { pid: 515, program: "postgres", cpuPercent: 3.25, residentBytes: 0.5 * gib },
        { pid: 77, program: "kworker/0:1-events", cpuPercent: 0, residentBytes: 0 },
      ]),
    });
    expect(view.gpu).toEqual(
      ok({
        gpus: [
          {
            name: "NVIDIA GeForce RTX 4090",
            utilizationPercent: { kind: "value", value: 63 },
            memoryUsedMiB: { kind: "value", value: 8192 },
            memoryTotalMiB: { kind: "value", value: 24576 },
            temperatureC: { kind: "value", value: 61 },
          },
        ],
        apps: ok([
          { pid: 4242, program: "trainer", memoryUsedMiB: { kind: "value", value: 8000 } },
          { pid: 9001, program: undefined, memoryUsedMiB: { kind: "not-reported" } },
        ]),
      }),
    );
  });

  test("reads a machine with no gpu as one", () => {
    expect(valueOf(decodeResourcesReport(edited((report) => ({ ...report, gpu: null })))).view.gpu).toBeUndefined();
  });

  test("keeps a failed reading as the other machine reported it", () => {
    const failed = { kind: "unreachable", reason: "cat exited 1" } as const;
    const machine = valueOf(decodeResourcesReport(southReport())).view.machine;
    const report = edited((parsed) => ({ ...parsed, machine: { ...machine, load: failed } }));
    expect(valueOf(decodeResourcesReport(report)).view.machine.load).toEqual(failed);
  });

  test("refuses another schema version", () => {
    expect(issueOf(decodeResourcesReport(edited((report) => ({ ...report, schemaVersion: 2 }))))).toContain("schemaVersion");
  });

  test("refuses a memory total of zero, which no machine has", () => {
    const machine = valueOf(decodeResourcesReport(southReport())).view.machine;
    const report = edited((parsed) => ({ ...parsed, machine: { ...machine, memory: ok({ usedBytes: 0, totalBytes: 0 }) } }));
    expect(decodeResourcesReport(report).kind).toBe("invalid");
  });

  test("refuses an instant it cannot read", () => {
    expect(issueOf(decodeResourcesReport(edited((report) => ({ ...report, generatedAt: "yesterday" }))))).toBe(
      "generatedAt is not an instant",
    );
  });

  test("refuses a login banner before the report", () => {
    expect(issueOf(decodeResourcesReport(`Welcome to south\n${southReport()}`))).toBe("the output is not JSON");
  });
});

const linuxView = () =>
  resourcesView({
    host: {
      platform: "linux",
      host: {
        ...ok({
          load: valueOf(decodeLoadavg(fixture("linux/loadavg.txt"))),
          cpuCount: valueOf(decodeOnlineCpus(fixture("linux/nprocessors-onln.txt"))),
          cpuUsage: valueOf(decodeCpuUsage(fixture("linux/stat.txt"))),
          memory: valueOf(decodeMeminfo(fixture("linux/meminfo.txt"))),
          arcReclaimableBytes: 0,
        }),
        capturedAt,
      },
    },
    processes: { ...decodeLinuxProcesses(fixture("linux/proc-stat.txt")), capturedAt },
    gpu: { ...ok({ gpus: valueOf(decodeGpus(fixture("linux/gpu.csv"))), apps: decodeComputeApps(fixture("linux/gpu-apps.csv")) }), capturedAt },
    disk: { ...ok(valueOf(decodeDf(fixture("linux/df.txt")))), capturedAt },
  });

describe("the resources report writer", () => {
  test("writes what the reader reads back, from the recorded linux answers", () => {
    const view = linuxView();
    const printed = JSON.stringify(resourcesReport({ generatedAt: capturedAt, view, tasks: undefined }));
    expect(valueOf(decodeResourcesReport(printed))).toEqual({ generatedAt: capturedAt, view, tasks: undefined });
  });

  test("leaves the tasks key out with no block, and writes a block the reader reads back", () => {
    const view = linuxView();
    expect(Object.keys(resourcesReport({ generatedAt: capturedAt, view, tasks: undefined }))).not.toContain("tasks");
    const tasks = ok([
      { id: "tasks-bridge-plot", processes: 5, cpuSeconds: 601.79, cpuCores: 8.01, residentBytes: 2 * gib, over: { memory: false } },
    ]);
    const printed = JSON.stringify(resourcesReport({ generatedAt: capturedAt, view, tasks }));
    expect(valueOf(decodeResourcesReport(printed)).tasks).toEqual(tasks);
  });
});

const at = (iso: string) => DateTime.makeUnsafe(iso);

describe("the machines view", () => {
  const remote = (generatedAt: string) => [{ name: "south", reading: ok({ generatedAt: at(generatedAt), view: linuxView(), tasks: undefined }) }];
  const now = at("2026-10-13T20:20:00Z");

  test("keeps a report under a minute old", () => {
    const [, south] = machinesView({ name: "north", view: linuxView() }, remote("2026-10-13T20:19:01Z"), now).machines;
    expect(south).toEqual({ name: "south", state: { kind: "ok", view: linuxView() } });
  });

  test("sets aside a report over a minute old", () => {
    const [, south] = machinesView({ name: "north", view: linuxView() }, remote("2026-10-13T20:18:59Z"), now).machines;
    expect(south).toEqual({ name: "south", state: { kind: "stale", generatedAt: at("2026-10-13T20:18:59Z") } });
  });

  // Both machines paint every 10 seconds, so a report over a minute old is stale.
  test("keeps the failure of a machine that did not answer", () => {
    const failed = { kind: "unreachable", reason: "sh exited 255" } as const;
    const [north, south] = machinesView({ name: "north", view: linuxView() }, [{ name: "south", reading: failed }], now).machines;
    expect(north.name).toBe("north");
    expect(south.state).toEqual(failed);
  });
});

const machinesWith = (env: Record<string, string>, answer: (command: Command) => Effect.Effect<string, CommandUnreachable>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const machines = yield* ResourceMachines;
      const readings = yield* Effect.forEach(machines.remotes, (remote) => remote.read);
      return { local: machines.local, names: machines.remotes.map((remote) => remote.name), readings };
    }).pipe(
      Effect.provide(
        resourceMachinesLayer.pipe(
          Layer.provide(Layer.succeed(CommandRunner, { run: answer })),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
        ),
      ),
    ),
  );

const remoteCommand = "ssh -o BatchMode=yes south.example.com 'cd tui-dash && bun run resources-json'";

describe("the remote resources source", () => {
  test("reads nothing remote when no command is configured", async () => {
    const found = await machinesWith({ TUI_DASH_REMOTE_RESOURCES: "  " }, () => Effect.die("no command runs"));
    expect(found).toEqual({ local: "local", names: [], readings: [] });
  });

  test("runs the configured command through the shell and reads its report", async () => {
    const asked: Array<Command> = [];
    const found = await machinesWith(
      { TUI_DASH_MACHINE: "north", TUI_DASH_REMOTE_MACHINE: "south", TUI_DASH_REMOTE_RESOURCES: remoteCommand },
      (command) => {
        asked.push(command);
        return Effect.succeed(southReport());
      },
    );
    expect(asked.map(({ argv }) => argv)).toEqual([["sh", "-c", remoteCommand]]);
    expect(Duration.toSeconds(asked[0]?.timeout ?? Duration.zero)).toBe(15);
    expect(found.local).toBe("north");
    expect(found.names).toEqual(["south"]);
    expect(valueOf(found.readings[0] ?? ok(undefined))).toEqual(valueOf(decodeResourcesReport(southReport())));
  });

  test("reports the command's failure as the machine's", async () => {
    const found = await machinesWith({ TUI_DASH_REMOTE_RESOURCES: remoteCommand }, () =>
      Effect.fail(new CommandUnreachable({ reason: "sh exited 255: ssh: connect to host south.example.com port 22: Connection refused" })),
    );
    expect(found.names).toEqual(["remote"]);
    expect(found.readings).toEqual([
      { kind: "unreachable", reason: "sh exited 255: ssh: connect to host south.example.com port 22: Connection refused" },
    ]);
  });
});
