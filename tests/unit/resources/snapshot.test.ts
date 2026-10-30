import { describe, expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { DateTime, Effect } from "effect";
import {
  decodeComputeApps,
  decodeCpuUsage,
  decodeDf,
  decodeGpus,
  decodeLinuxProcesses,
  decodeLoadavg,
  decodeMeminfo,
  decodeOnlineCpus,
  ok,
  resourcesView,
} from "@tui-dash/schema";
import { blockDocument, type Block, frameText, plain } from "@tui-dash/ui";
import { resourceLines } from "@tui-dash/resources";
import { fixture } from "../../lib/fixtures";

const now = DateTime.makeUnsafe("2026-10-13T20:18:16Z");

const width = 84;

const val = <A>(outcome: { kind: string; value?: A }): A => {
  if (outcome.kind !== "ok" || outcome.value === undefined) throw new Error("the fixture does not decode");
  return outcome.value;
};

const view = () =>
  resourcesView({
    host: {
      platform: "linux",
      host: {
        ...ok({
          load: val(decodeLoadavg(fixture("linux/loadavg.txt"))),
          cpuCount: val(decodeOnlineCpus(fixture("linux/nprocessors-onln.txt"))),
          cpuUsage: val(decodeCpuUsage(fixture("linux/stat.txt"))),
          memory: val(decodeMeminfo(fixture("linux/meminfo.txt"))),
          arcReclaimableBytes: 0,
        }),
        capturedAt: now,
      },
    },
    processes: { ...decodeLinuxProcesses(fixture("linux/proc-stat.txt")), capturedAt: now },
    disk: { ...ok(val(decodeDf(fixture("linux/df.txt")))), capturedAt: now },
    gpu: {
      ...ok({
        gpus: val(decodeGpus(fixture("linux/gpu.csv"))),
        apps: decodeComputeApps(fixture("linux/gpu-apps.csv")),
      }),
      capturedAt: now,
    },
  });

const lines = (): Block => resourceLines(view(), width);

const divide = String.fromCharCode(10);

const normalize = (frame: string): string =>
  frame
    .split(divide)
    .map((row) => row.trimEnd())
    .join(divide)
    .trimEnd();

const pinned = (): string => normalize(fixture("screens/resources-84x23.txt"));

const rendered = async (rows: Block) => {
  const setup = await createTestRenderer({ width, height: rows.length + 1 });
  const text = new TextRenderable(setup.renderer, { content: blockDocument(rows) });
  setup.renderer.root.add(text);
  await setup.renderOnce();
  return setup;
};

const edge = "│";
const full = "█";
const empty = "░";

describe("the resources panel, against the pinned linux output", () => {
  test("renders the pinned frame through OpenTUI", async () => {
    const rows = lines();
    const setup = await rendered(rows);
    const frame = normalize(setup.captureCharFrame());
    await setup.dispose();
    expect(frame).toBe(pinned());
    expect(frame.split(divide)).toHaveLength(23);
  });

  test("the print path renders the same frame", async () => {
    const rows = lines();
    const frame = await Effect.runPromise(frameText(blockDocument(rows), width, rows.length + 1));
    expect(frame).toBe(pinned());
  });
});

describe("the resources panel, against hand sums of the linux fixtures", () => {
  const text = (): ReadonlyArray<string> => lines().map(plain);

  test("names the core count getconf _NPROCESSORS_ONLN reports", () => {
    expect(text()[1]).toBe(edge + " 16 cores" + " ".repeat(72) + " " + edge);
  });

  test("cpu is the 175 busy of 1618 jiffies, 7 of 63 cells wide", () => {
    expect(text()[2]).toBe(edge + " cpu   " + full.repeat(7) + empty.repeat(56) + "        11% " + edge);
  });

  test("memory is MemTotal less MemAvailable, 11 of 63 cells wide", () => {
    expect(text()[3]).toBe(edge + " mem   " + full.repeat(11) + empty.repeat(52) + "  5.5/31.3G " + edge);
  });

  test("the busiest process is pi with 162 of 1618 jiffies and 467956 KiB resident", () => {
    expect(text()[5]).toBe(edge + "   492953  pi" + " ".repeat(17) + "  10%  0.4G" + " ".repeat(40) + " " + edge);
  });

  test("the gpu meter is nvidia-smi's 9 of 100", () => {
    expect(text()[17]).toBe(edge + " gpu   " + full.repeat(6) + empty.repeat(57) + "         9% " + edge);
  });

  test("vram is nvidia-smi's 1871 of 16384 MiB", () => {
    expect(text()[18]).toBe(edge + " vram  " + full.repeat(7) + empty.repeat(56) + "  1.8/16.0G " + edge);
  });

  test("the compute app keeps the pid's process name and its unreported memory", () => {
    expect(text()[21]).toBe(edge + "   3809535 python" + " ".repeat(9) + "not reported" + " ".repeat(43) + " " + edge);
  });
});

describe("the tables at the live panel's 30 and 40 column widths", () => {
  const withTrainer = () => {
    const fixtures = view();
    const gpus = val(fixtures.gpu ?? { kind: "missing" });
    const trainer = { pid: 4242, program: "trainer", memoryUsedMiB: { kind: "value" as const, value: 2048 } };
    return { ...fixtures, gpu: ok({ ...gpus, apps: ok([...val(gpus.apps), trainer]) }) };
  };

  for (const narrow of [30, 40]) {
    test(`at ${narrow} columns the gpu apps keep nvidia-smi's [N/A] as not reported and 2048 MiB whole`, () => {
      const rows = resourceLines(withTrainer(), narrow).map(plain);
      expect(rows.every((row) => row.length === narrow)).toBe(true);
      expect(rows.at(-4)).toEndWith(" VRAM" + " ".repeat(8) + " " + edge);
      expect(rows.at(-3)).toEndWith(" not reported " + edge);
      expect(rows.at(-2)).toMatch(new RegExp(" 2048MiB +" + edge + "$"));
    });

    test(`at ${narrow} columns the process header keeps Cpu and Mem over their columns`, () => {
      const rows = resourceLines(withTrainer(), narrow).map(plain);
      expect(rows[4]?.indexOf("Cpu")).toBe(rows[5]?.indexOf("10%"));
      expect(rows[4]?.indexOf("Mem")).toBe(rows[5]?.indexOf("0.4G"));
    });
  }
});

describe("the gpu panel when only the compute apps query fails", () => {
  const text = (): ReadonlyArray<string> => lines().map(plain);

  test("keeps the recorded 9% gpu, 1.8/16.0G vram and 46C rows and puts the failure in the app table", () => {
    const fixtures = view();
    const gpus = val(fixtures.gpu ?? { kind: "missing" });
    const apps = { kind: "unreachable" as const, reason: "nvidia-smi exited 6" };
    const rows = resourceLines({ ...fixtures, gpu: ok({ ...gpus, apps }) }, width).map(plain);
    expect(rows.slice(16, 20)).toEqual(text().slice(16, 20));
    expect(rows[20]).toBe(edge + " " + "\u2717 unreachable: nvidia-smi exited 6".padEnd(width - 4) + " " + edge);
  });
});

describe("readings wider than their columns at the live panel's 30 column minimum", () => {
  const narrow = 30;
  const tib = 1024 ** 4;

  test("a process holding 1024 GiB keeps 1024.0G whole, with Cpu and Mem over their columns", () => {
    const fixtures = view();
    const processes = val(fixtures.machine.processes).map((process, index) =>
      index === 0 ? { ...process, residentBytes: tib } : process,
    );
    const machine = { ...fixtures.machine, processes: ok(processes) };
    const rows = resourceLines({ ...fixtures, machine }, narrow).map(plain);
    expect(rows.every((row) => row.length === narrow)).toBe(true);
    expect(rows[5]).toEndWith(" 10%  1024.0G " + edge);
    expect(rows[4]?.indexOf("Mem")).toBe(rows[5]?.indexOf("1024.0G"));
    expect(rows[4]?.indexOf("Cpu")).toBe(rows[5]?.indexOf("10%"));
  });

  test("a process at 12800% cpu keeps it whole", () => {
    const fixtures = view();
    const processes = val(fixtures.machine.processes).map((process, index) =>
      index === 0 ? { ...process, cpuPercent: 12800 } : process,
    );
    const machine = { ...fixtures.machine, processes: ok(processes) };
    const rows = resourceLines({ ...fixtures, machine }, narrow).map(plain);
    expect(rows.every((row) => row.length === narrow)).toBe(true);
    expect(rows[5]).toEndWith(" 12800%  0.4G   " + edge);
  });

  test("load averages of 128.75 keep all three whole", () => {
    const fixtures = view();
    const machine = { ...fixtures.machine, load: ok([128.75, 128.75, 128.75] as const) };
    const rows = resourceLines({ ...fixtures, machine }, narrow).map(plain);
    expect(rows.every((row) => row.length === narrow)).toBe(true);
    expect(rows).toContain(edge + " load 128.75 128.75 128.75  " + edge);
  });

  test("memory of 16384 GiB used of 32768 GiB keeps 16384.0/32768.0G whole", () => {
    const fixtures = view();
    const memory = ok({ usedBytes: 16 * tib, totalBytes: 32 * tib });
    const rows = resourceLines({ ...fixtures, machine: { ...fixtures.machine, memory } }, narrow).map(plain);
    expect(rows.every((row) => row.length === narrow)).toBe(true);
    expect(rows[3]).toBe(edge + " mem   " + full.repeat(2) + empty + " 16384.0/32768.0G " + edge);
  });
});

describe("a meter value wider than its 10 columns", () => {
  const halfOf256G = (label: string) =>
    edge + " " + label.padEnd(6) + full.repeat(31) + empty.repeat(30) + " 128.0/256.0G " + edge;

  test("memory of 128 GiB used of 256 GiB keeps its whole value, half of a bar narrowed to fit", () => {
    const fixtures = view();
    const memory = ok({ usedBytes: 128 * 1024 ** 3, totalBytes: 256 * 1024 ** 3 });
    const rows = resourceLines({ ...fixtures, machine: { ...fixtures.machine, memory } }, width).map(plain);
    expect(rows[3]).toBe(halfOf256G("mem"));
  });

  test("vram of 131072 MiB used of 262144 MiB keeps its whole value, half of a bar narrowed to fit", () => {
    const fixtures = view();
    const gpus = val(fixtures.gpu ?? { kind: "missing" });
    const wide = {
      ...gpus.gpus[0],
      memoryUsedMiB: { kind: "value" as const, value: 131072 },
      memoryTotalMiB: { kind: "value" as const, value: 262144 },
    };
    const rows = resourceLines({ ...fixtures, gpu: ok({ ...gpus, gpus: [wide] }) }, width).map(plain);
    expect(rows[18]).toBe(halfOf256G("vram"));
  });
});
