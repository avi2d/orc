import { Context, Duration, Effect, Layer, Schema } from "effect";
import type { Command, CommandRunner } from "../command";
import { type Decoded, decodeValue, flatMapDecoded } from "../decode";
import { mapOutcome, type Outcome } from "../reading";
import { runDecoded, sourceOf, stamped, type Source } from "../source";
import { nonEmptyLines, splitEach } from "./lines";
import { AmountText, CountText } from "./numerals";

const NotReported = Schema.Literals(["[N/A]", "[Not Supported]"]);

const Metric = Schema.Union([AmountText, NotReported]);

const GpuRow = Schema.Struct({
  name: Schema.NonEmptyString,
  utilizationPercent: Metric,
  memoryUsedMiB: Metric,
  memoryTotalMiB: Metric,
  temperatureC: Metric,
});

const ComputeApp = Schema.Struct({
  pid: CountText,
  name: Schema.String,
  memoryUsedMiB: Metric,
});

export type GpuMetric = typeof Metric.Type;
export type GpuRow = typeof GpuRow.Type;
export type ComputeApp = typeof ComputeApp.Type;

export interface GpuReading {
  readonly gpus: ReadonlyArray<GpuRow>;
  readonly apps: Outcome<ReadonlyArray<ComputeApp>>;
}

const cells = (line: string) => line.split(",").map((cell) => cell.trim());

const splitGpu = (line: string) => {
  const row = cells(line);
  const [name, utilizationPercent, memoryUsedMiB, memoryTotalMiB, temperatureC] = row;
  return row.length === 5 ? { name, utilizationPercent, memoryUsedMiB, memoryTotalMiB, temperatureC } : undefined;
};

const splitApp = (line: string) => {
  const first = line.indexOf(",");
  const last = line.lastIndexOf(",");
  if (first === last) return undefined;
  return {
    pid: line.slice(0, first).trim(),
    name: line.slice(first + 1, last).trim(),
    memoryUsedMiB: line.slice(last + 1).trim(),
  };
};

export const decodeGpus = (stdout: string): Decoded<ReadonlyArray<GpuRow>> =>
  flatMapDecoded(
    splitEach(nonEmptyLines(stdout), "name, utilization, memory used, memory total and temperature", splitGpu),
    decodeValue(Schema.NonEmptyArray(GpuRow)),
  );

export const decodeComputeApps = (stdout: string): Decoded<ReadonlyArray<ComputeApp>> =>
  flatMapDecoded(
    splitEach(nonEmptyLines(stdout), "pid, process name and memory used", splitApp),
    decodeValue(Schema.Array(ComputeApp)),
  );

const gpuCommand = (program: string): Command => ({
  argv: [program, "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"],
  timeout: Duration.seconds(10),
});

const computeAppsCommand = (program: string): Command => ({
  argv: [program, "--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"],
  timeout: Duration.seconds(10),
});

const readWith = (program: string): Effect.Effect<Outcome<GpuReading>, never, CommandRunner> =>
  Effect.all([runDecoded(gpuCommand(program), decodeGpus), runDecoded(computeAppsCommand(program), decodeComputeApps)], {
    concurrency: "unbounded",
  }).pipe(Effect.map(([gpus, apps]) => mapOutcome(gpus, (rows) => ({ gpus: rows, apps }))));

// WSL keeps nvidia-smi in its driver library folder, which is not on the PATH.
const wslNvidiaSmi = "/usr/lib/wsl/lib/nvidia-smi";

// The PATH's failure is the one reported, since the WSL folder is absent everywhere but WSL.
const readGpu: Effect.Effect<Outcome<GpuReading>, never, CommandRunner> = readWith("nvidia-smi").pipe(
  Effect.filterOrElse(
    (onPath) => onPath.kind !== "unreachable",
    (onPath) => Effect.map(readWith(wslNvidiaSmi), (inWsl) => (inWsl.kind === "unreachable" ? onPath : inWsl)),
  ),
);

export class GpuSource extends Context.Service<GpuSource, Source<GpuReading>>()("tui-dash/GpuSource") {}

export const gpuSourceLayer = Layer.effect(GpuSource, sourceOf(stamped(readGpu)));
