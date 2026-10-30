import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { TestConsole } from "effect/testing";
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
import { printResourcesFrame } from "@tui-dash/resources";
import { fixture } from "../../lib/fixtures";
import { escape, stripSgr } from "../../e2e/lib/print-color";

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

const printed = (color: boolean): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* printResourcesFrame(84, Number.POSITIVE_INFINITY, color);
      return (yield* TestConsole.logLines).map(String).join("\n");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mergeAll(
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
          ),
          TestConsole.layer,
        ),
      ),
    ),
  );

// Oracle: the meter in packages/resources/src/panels.ts labels each gauge in subtle, and the palette holds subtle at
// #adb1ba. Rejects a colour frame that maps the gauge labels to another colour.
describe("the resources --print --color frame", () => {
  test("paints the gauge labels in subtle", async () => {
    expect(await printed(true)).toContain(`${escape}[38;2;173;177;186mcpu   `);
  });

  test("carries no visible text the plain frame does not carry, which itself carries no escape", async () => {
    const plain = await printed(false);
    expect(plain).not.toContain(escape);
    expect(stripSgr(await printed(true))).toBe(plain);
  });
});
