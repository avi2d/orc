import { describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { Effect, Fiber, Layer } from "effect";
import {
  CommandRunner,
  gpuSourceLayer,
  linuxDiskSourceLayer,
  linuxHostSourceLayer,
  linuxProcessesSourceLayer,
  macDiskSourceLayer,
  macHostSourceLayer,
  macProcessesSourceLayer,
  ResourceMachines,
} from "@tui-dash/schema";
import { livePanel } from "@tui-dash/resources";
import { fixture } from "../../lib/fixtures";

const recordedAnswers: ReadonlyArray<readonly [string, string]> = [
  ["sysctl -n", fixture("mac/sysctl.txt")],
  ["vm_stat", fixture("mac/vm_stat.txt")],
  ["top -l", fixture("mac/top.txt")],
  ["ps -A", fixture("mac/ps.txt")],
  ["cat /proc/loadavg", fixture("linux/loadavg.txt")],
  ["getconf _NPROCESSORS_ONLN", fixture("linux/nprocessors-onln.txt")],
  ["cat /proc/meminfo", fixture("linux/meminfo.txt")],
  ["df -kP /", fixture("linux/df.txt")],
  ["sh -c df -kP", fixture("mac/df.txt")],
  ["sh -c head -n 1", fixture("linux/stat.txt")],
  ["sh -c sample()", fixture("linux/proc-stat-cmdline.txt")],
  ["nvidia-smi --query-gpu", fixture("linux/gpu.csv")],
  ["nvidia-smi --query-compute-apps", fixture("linux/gpu-apps.csv")],
];

const recordedSources = Layer.mergeAll(
  macHostSourceLayer,
  macProcessesSourceLayer,
  macDiskSourceLayer,
  linuxHostSourceLayer,
  linuxProcessesSourceLayer,
  linuxDiskSourceLayer,
  gpuSourceLayer,
  Layer.succeed(ResourceMachines, { local: "local", remotes: [] }),
).pipe(
  Layer.provide(
    Layer.succeed(CommandRunner, {
      run: (command) =>
        Effect.succeed(recordedAnswers.find(([asked]) => command.argv.join(" ").startsWith(asked))?.[1] ?? ""),
    }),
  ),
);

const divide = String.fromCharCode(10);

const rowsOf = (frame: string): ReadonlyArray<string> =>
  frame
    .split(divide)
    .map((row) => row.trimEnd())
    .filter((row) => row !== "");

const frameWhere = async (setup: TestRendererSetup, matches: (frame: string) => boolean): Promise<string> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await Bun.sleep(25);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (matches(frame)) return frame;
  }
  throw new Error("no frame matched");
};

const expected =
  process.platform === "darwin"
    ? { platform: "mac", cores: "10 cores", cpu: "14%" }
    : { platform: "linux", cores: "16 cores", cpu: "11%" };

describe("the live panel", () => {
  test(`paints its first reading from the canned ${expected.platform} answers, and lays it out again for a narrower terminal`, async () => {
    const setup = await createTestRenderer({ width: 84, height: 24 });
    const fiber = Effect.runFork(livePanel(setup.renderer).pipe(Effect.provide(recordedSources)));
    try {
      const wide = rowsOf(await frameWhere(setup, (frame) => frame.includes(expected.cores)));
      expect(wide.join(divide)).toContain("NVIDIA GeForce RTX 3080 Laptop GPU");
      setup.resize(40, 24);
      const narrow = rowsOf(await frameWhere(setup, (frame) => frame.split(divide)[0]?.length === 40));
      expect(narrow).toHaveLength(wide.length);
      expect(narrow.find((row) => row.startsWith("│ cpu "))).toEndWith(` ${expected.cpu} │`);
      expect(narrow.join(divide)).toContain("9%");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  });
});
