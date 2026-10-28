import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { CommandRunner, CommandUnreachable, decodeComputeApps, decodeGpus, GpuSource, gpuSourceLayer } from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { issueOf, valueOf } from "../../lib/outcomes";

describe("the nvidia-smi readers against the recorded linux output", () => {
  test("decodeGpus reads name, utilization, memory and temperature", () => {
    expect(valueOf(decodeGpus(fixture("linux/gpu.csv")))).toEqual([
      {
        name: "NVIDIA GeForce RTX 3080 Laptop GPU",
        utilizationPercent: 9,
        memoryUsedMiB: 1871,
        memoryTotalMiB: 16384,
        temperatureC: 46,
      },
    ]);
  });

  test("decodeComputeApps keeps WSL's [Not Found] name and [N/A] memory as nvidia-smi wrote them", () => {
    expect(valueOf(decodeComputeApps(fixture("linux/gpu-apps.csv")))).toEqual([
      { pid: 3809535, name: "[Not Found]", memoryUsedMiB: "[N/A]" },
    ]);
  });

  test("no compute apps is an empty list", () => {
    expect(valueOf(decodeComputeApps(""))).toEqual([]);
  });
});

describe("the nvidia-smi readers against changed formats", () => {
  test("figures with units are invalid, never a number", () => {
    expect(issueOf(decodeGpus(fixture("linux/gpu-changed.csv")))).toContain("utilizationPercent");
  });

  test("a sixth column is invalid", () => {
    expect(issueOf(decodeGpus("GPU, 1, 2, 3, 4, 5\n"))).toBe(
      "line 1 does not read as name, utilization, memory used, memory total and temperature",
    );
  });

  test("a process name with commas in it stays whole between the first field, the pid, and the last, the memory", () => {
    expect(valueOf(decodeComputeApps("4242, /opt/run,v2/train, model.py, 2048\n"))).toEqual([
      { pid: 4242, name: "/opt/run,v2/train, model.py", memoryUsedMiB: 2048 },
    ]);
  });

  test("a compute app row of two columns is invalid", () => {
    expect(issueOf(decodeComputeApps("4242, 2048\n"))).toBe("line 1 does not read as pid, process name and memory used");
  });

  test("no GPU at all is invalid", () => {
    expect(decodeGpus("").kind).toBe("invalid");
  });
});

describe("the nvidia-smi readers against a field the GPU does not support", () => {
  test("keeps nvidia-smi's [Not Supported] as it wrote it", () => {
    const [gpu] = valueOf(decodeGpus("NVIDIA GeForce RTX 3080 Laptop GPU, 9, 1871, 16384, [Not Supported]\n"));
    expect(gpu.temperatureC).toBe("[Not Supported]");
  });
});

describe("the gpu source when only the compute apps query fails", () => {
  const readWith = (apps: Effect.Effect<string, CommandUnreachable>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* GpuSource;
        return yield* source.read;
      }).pipe(
        Effect.provide(gpuSourceLayer),
        Effect.provideService(CommandRunner, {
          run: (command) =>
            command.argv.join(" ").includes("--query-compute-apps")
              ? apps
              : Effect.succeed(fixture("linux/gpu.csv")),
        }),
      ),
    );

  test("an unreachable apps query keeps the recorded gpu figures", async () => {
    const reading = valueOf(await readWith(Effect.fail(new CommandUnreachable({ reason: "nvidia-smi exited 6" }))));
    expect(reading.gpus).toEqual(valueOf(decodeGpus(fixture("linux/gpu.csv"))));
    expect(reading.apps).toEqual({ kind: "unreachable", reason: "nvidia-smi exited 6" });
  });

  test("an undecodable apps answer keeps the recorded gpu figures", async () => {
    const reading = valueOf(await readWith(Effect.succeed("not, a pid, 1\n")));
    expect(reading.gpus[0]?.utilizationPercent).toBe(9);
    expect(reading.apps.kind).toBe("invalid");
  });
});

const readAnswering = (answer: (program: string, query: string) => Effect.Effect<string, CommandUnreachable>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const source = yield* GpuSource;
      return yield* source.read;
    }).pipe(
      Effect.provide(gpuSourceLayer),
      Effect.provideService(CommandRunner, { run: ({ argv: [program, query] }) => answer(program, query) }),
    ),
  );

const notStarted = (program: string) => Effect.fail(new CommandUnreachable({ reason: `${program} did not start` }));

describe("the gpu source on WSL, where nvidia-smi is not on the PATH", () => {
  const wsl = "/usr/lib/wsl/lib/nvidia-smi";

  test("reads the GPU through WSL's own nvidia-smi", async () => {
    const reading = await readAnswering((program, query) =>
      program !== wsl
        ? notStarted(program)
        : Effect.succeed(fixture(query.startsWith("--query-gpu") ? "linux/gpu.csv" : "linux/gpu-apps.csv")),
    );
    expect(valueOf(reading).gpus).toEqual(valueOf(decodeGpus(fixture("linux/gpu.csv"))));
    expect(valueOf(reading).apps).toEqual(decodeComputeApps(fixture("linux/gpu-apps.csv")));
  });

  test("reports the PATH's failure when neither nvidia-smi starts", async () => {
    const reading = await readAnswering(notStarted);
    expect(reading).toMatchObject({ kind: "unreachable", reason: "nvidia-smi did not start" });
  });
});
