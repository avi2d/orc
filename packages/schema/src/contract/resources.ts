import { Schema } from "effect";

import { outcomeOf } from "../shared/lib/outcome";

const Figure = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const Whole = Schema.Finite.check(Schema.isGreaterThan(0));

const MeasuredJson = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("value"), value: Figure }),
  Schema.Struct({ kind: Schema.Literal("not-reported") }),
]);

export const ProcessJson = Schema.Struct({ pid: Figure, program: Schema.String, cpuPercent: Figure, residentBytes: Figure });

const DiskJson = Schema.Struct({ usedBytes: Figure, totalBytes: Whole });

const MachineJson = Schema.Struct({
  cpu: outcomeOf(Schema.Struct({ percent: Figure, cores: Whole })),
  memory: outcomeOf(Schema.Struct({ usedBytes: Figure, totalBytes: Whole })),
  disk: Schema.optionalKey(outcomeOf(DiskJson)),
  load: outcomeOf(Schema.Tuple([Figure, Figure, Figure])),
  processes: outcomeOf(Schema.Array(ProcessJson)),
});

const GpuJson = Schema.Struct({
  name: Schema.String,
  utilizationPercent: MeasuredJson,
  memoryUsedMiB: MeasuredJson,
  memoryTotalMiB: MeasuredJson,
  temperatureC: MeasuredJson,
});

export const GpuAppJson = Schema.Struct({ pid: Figure, program: Schema.NullOr(Schema.String), memoryUsedMiB: MeasuredJson });

const GpusJson = Schema.Struct({ gpus: Schema.Array(GpuJson), apps: outcomeOf(Schema.Array(GpuAppJson)) });

const TaskResourcesJson = Schema.Struct({
  id: Schema.String,
  processes: Whole,
  cpuSeconds: Figure,
  cpuCores: Figure,
  residentBytes: Figure,
  over: Schema.Struct({ memory: Schema.Boolean }),
});

export const ResourcesReport = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generatedAt: Schema.String,
  machine: MachineJson,
  gpu: Schema.NullOr(outcomeOf(GpusJson)),
  tasks: Schema.optionalKey(outcomeOf(Schema.Array(TaskResourcesJson))),
});

export type ResourcesReport = typeof ResourcesReport.Type;

