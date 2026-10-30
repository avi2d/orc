import { DateTime, Option, Schema } from "effect";
import { type Decoded, decodeJson, decoded, flatMapDecoded, rejected } from "../decode";
import { mapOutcome } from "../reading";
import type { GpuAppView, ReportedResources } from "../views/resources";
import { outcomeOf } from "./outcome";

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

const GpuAppJson = Schema.Struct({ pid: Figure, program: Schema.NullOr(Schema.String), memoryUsedMiB: MeasuredJson });

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

const appJson = (app: GpuAppView): typeof GpuAppJson.Type => ({ ...app, program: app.program ?? null });

const appOf = (app: typeof GpuAppJson.Type): GpuAppView => ({ ...app, program: app.program ?? undefined });

export const resourcesReport = ({ generatedAt, view, tasks }: ReportedResources): ResourcesReport => {
  const { disk, ...machine } = view.machine;
  return {
    schemaVersion: 1,
    generatedAt: DateTime.formatIso(generatedAt),
    machine: disk === undefined ? machine : { ...machine, disk },
    gpu: view.gpu === undefined ? null : mapOutcome(view.gpu, (gpus) => ({ ...gpus, apps: mapOutcome(gpus.apps, (apps) => apps.map(appJson)) })),
    ...(tasks === undefined ? {} : { tasks }),
  };
};

const reportedOf = (report: ResourcesReport): Decoded<ReportedResources> =>
  Option.match(DateTime.make(report.generatedAt), {
    onNone: () => rejected("generatedAt is not an instant"),
    onSome: (generatedAt) =>
      decoded({
        generatedAt: DateTime.toUtc(generatedAt),
        view: {
          machine: { ...report.machine, disk: report.machine.disk },
          gpu:
            report.gpu === null
              ? undefined
              : mapOutcome(report.gpu, (gpus) => ({ ...gpus, apps: mapOutcome(gpus.apps, (apps) => apps.map(appOf)) })),
        },
        tasks: report.tasks,
      }),
  });

export const decodeResourcesReport = (stdout: string): Decoded<ReportedResources> =>
  flatMapDecoded(decodeJson(ResourcesReport)(stdout), reportedOf);
