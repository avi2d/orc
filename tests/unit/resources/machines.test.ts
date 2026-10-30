import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import {
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
  type RemoteResources,
  resourcesView,
} from "@tui-dash/schema";
import { lineWidth, plain } from "@tui-dash/ui";
import { machinesLines } from "@tui-dash/resources";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";

const now = DateTime.makeUnsafe("2026-10-13T20:18:16Z");

const width = 84;

const north = () =>
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
        capturedAt: now,
      },
    },
    processes: { ...decodeLinuxProcesses(fixture("linux/proc-stat.txt")), capturedAt: now },
    gpu: { ...ok({ gpus: valueOf(decodeGpus(fixture("linux/gpu.csv"))), apps: decodeComputeApps(fixture("linux/gpu-apps.csv")) }), capturedAt: now },
    disk: { ...ok(valueOf(decodeDf(fixture("linux/df.txt")))), capturedAt: now },
  });

const south = () => valueOf(decodeResourcesReport(fixture("resources/south.json")));

const twoMachines = (reading: RemoteResources["reading"]) =>
  machinesView({ name: "north", view: north() }, [{ name: "south", reading }], now);

const printed = (reading: RemoteResources["reading"], rows = Number.POSITIVE_INFINITY, columns = width) =>
  machinesLines(twoMachines(reading), columns, rows).map(plain);

const titles = (rows: ReadonlyArray<string>) => rows.flatMap((row) => /^╭─ (.+?) ─/u.exec(row)?.slice(1) ?? []);

// Oracle: the pinned 84x23 frame of the recorded linux answers, drawn before a second machine could be configured.
// Rejects a lone machine titled by its name, or its gpu panel or any figure left out.
describe("the resources panel alone", () => {
  test("draws what it drew before a second machine could be configured", () => {
    const alone = machinesView({ name: "north", view: north() }, [], now);
    expect(machinesLines(alone, width, Number.POSITIVE_INFINITY).map(plain)).toEqual(fixture("screens/resources-84x23.txt").trimEnd().split("\n"));
  });
});

// Oracle: the invented south report, its trainer at 37.5% of the cpu with 2 GiB resident, its load of 3.50 2.25 1.75 and
// its RTX 4090 at 61C, beside the recorded linux answers for north. Rejects a second machine drawn under this machine's
// titles, or its load, processes or gpu left out.
describe("the resources panel with a second machine configured", () => {
  test("titles each machine's panels by its name, this machine first", () => {
    expect(titles(printed(ok(south())))).toEqual(["north", "north gpu", "south", "south gpu"]);
  });

  test("shows the other machine's cpu, memory, load, busiest processes and gpu", () => {
    const rows = printed(ok(south()));
    const southRows = rows.slice(rows.findIndex((row) => row.startsWith("╭─ south ")));
    const text = southRows.join("\n");
    expect(text).toContain("16 cores");
    expect(text).toMatch(/│ cpu +█+░+ +42% │/u);
    expect(text).toMatch(/│ mem +█+░+ +12\.0\/64\.0G │/u);
    expect(text).toContain("· load 3.50 2.25 1.75");
    expect(text).toMatch(/4242 +trainer +38% {2}2\.0G/u);
    expect(text).toMatch(/515 +postgres +3% {2}0\.5G/u);
    expect(text).toContain("NVIDIA GeForce RTX 4090");
    expect(text).toContain("· temp 61C");
  });

  // Oracle: the recorded table's eight processes fill north's list, so a cap under eight costs a +N more row, and four rows
  // fewer leave three. Rejects a fit that drops the other machine's three processes while this machine keeps its own.
  test("caps every machine's process rows alike to fit a short terminal", () => {
    const tall = printed(ok(south()));
    const rows = printed(ok(south()), tall.length - 4);
    const processRows = (from: string, to: string) =>
      rows.slice(rows.findIndex((row) => row.startsWith(`╭─ ${from} `)), rows.findIndex((row) => row.startsWith(`╭─ ${to} `))).filter((row) => /^│ {3}\d+ /u.test(row));
    expect(rows.length).toBeLessThanOrEqual(tall.length - 4);
    expect(titles(rows)).toEqual(["north", "north gpu", "south", "south gpu"]);
    expect(processRows("north", "north gpu")).toHaveLength(3);
    expect(processRows("south", "south gpu").map((row) => /^│ {3}\d+ +(\S+)/u.exec(row)?.[1])).toEqual(["trainer", "postgres", "kworker/0:1-events"]);
  });

  test("keeps every row inside a 30 column terminal", () => {
    for (const row of machinesLines(twoMachines(ok(south())), 30, Number.POSITIVE_INFINITY)) expect(lineWidth(row)).toBeLessThanOrEqual(30);
  });

  // Oracle: ssh's own words for a refused connection. Rejects a remote failure that hides this machine's panels.
  test("draws the other machine's failure in its panel, beside this machine's panels", () => {
    const rows = printed({ kind: "unreachable", reason: "sh exited 255: ssh: connect to host south port 22: Connection refused" });
    expect(titles(rows)).toEqual(["north", "north gpu", "south"]);
    expect(rows.slice(-3, -1).map((row) => row.slice(2, -2).trimEnd())).toEqual([
      "✗ unreachable: sh exited 255: ssh: connect to host south port 22: Connection",
      "refused",
    ]);
  });

  // Oracle: the README's minute after which another machine's report is too old to show.
  test("leaves out a report older than a minute and says how old it is", () => {
    const rows = printed(ok({ ...south(), generatedAt: DateTime.makeUnsafe("2026-10-13T20:15:16Z") }));
    expect(rows.at(-2)).toMatch(/^│ ! answered 3m ago, so its readings are left out +│$/u);
  });
});
