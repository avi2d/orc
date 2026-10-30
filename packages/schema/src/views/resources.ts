import { DateTime } from "effect";
import { type Failed, mapOutcome, type Outcome, type Reading, zipOutcomes } from "../reading";
import type { DiskUsage } from "../sources/disk";
import type { ComputeApp, GpuMetric, GpuReading } from "../sources/gpu";
import type { LinuxHost } from "../sources/linux-host";
import type { MacHost } from "../sources/mac-host";
import type { ProcessRow } from "../sources/processes";
import type { ProcessSamples } from "../sources/task-processes";
import type { ReportedTasks } from "../contract/tasks";
import { type TaskResources, taskResources } from "./task-resources";

export interface ProcessView {
  readonly pid: number;
  readonly program: string;
  readonly cpuPercent: number;
  readonly residentBytes: number;
}

export interface CpuView {
  readonly percent: number;
  readonly cores: number;
}

export interface MemoryView {
  readonly usedBytes: number;
  readonly totalBytes: number;
}

export interface DiskView {
  readonly usedBytes: number;
  readonly totalBytes: number;
}

export type LoadAverages = readonly [number, number, number];

export interface MachineView {
  readonly cpu: Outcome<CpuView>;
  readonly memory: Outcome<MemoryView>;
  readonly disk: Outcome<DiskView> | undefined;
  readonly load: Outcome<LoadAverages>;
  readonly processes: Outcome<ReadonlyArray<ProcessView>>;
}

export type Measured = { readonly kind: "value"; readonly value: number } | { readonly kind: "not-reported" };

export interface GpuView {
  readonly name: string;
  readonly utilizationPercent: Measured;
  readonly memoryUsedMiB: Measured;
  readonly memoryTotalMiB: Measured;
  readonly temperatureC: Measured;
}

export interface GpuAppView {
  readonly pid: number;
  readonly program: string | undefined;
  readonly memoryUsedMiB: Measured;
}

export interface GpusView {
  readonly gpus: ReadonlyArray<GpuView>;
  readonly apps: Outcome<ReadonlyArray<GpuAppView>>;
}

export interface ResourcesView {
  readonly machine: MachineView;
  readonly gpu: Outcome<GpusView> | undefined;
}

export type HostReading =
  | { readonly platform: "mac"; readonly host: Reading<MacHost> }
  | { readonly platform: "linux"; readonly host: Reading<LinuxHost> };

export interface ResourceReadings {
  readonly host: HostReading;
  readonly processes: Reading<ReadonlyArray<ProcessRow>>;
  readonly gpu: Reading<GpuReading>;
  readonly disk: Reading<DiskUsage>;
}

// A kernel thread's comm such as kworker/0:1 holds a slash too, so only a path gets cut to its last part.
const programOf = (command: string): string =>
  command.startsWith("/") ? command.slice(command.lastIndexOf("/") + 1) : command;

const busiestFirst = (rows: ReadonlyArray<ProcessRow>): ReadonlyArray<ProcessView> =>
  rows
    .map((row) => ({
      pid: row.pid,
      program: programOf(row.command),
      cpuPercent: row.cpuPercent,
      residentBytes: row.residentKiB * 1024,
    }))
    .toSorted((a, b) => b.cpuPercent - a.cpuPercent || b.residentBytes - a.residentBytes);

const macMemory = ({ sysctl, vmStat }: MacHost): MemoryView => ({
  usedBytes: (vmStat["Pages active"] + vmStat["Pages wired down"]) * vmStat.pageSizeBytes,
  totalBytes: sysctl.memoryBytes,
});

const macMachineView = (host: Outcome<MacHost>, processes: Outcome<ReadonlyArray<ProcessRow>>, disk: Outcome<DiskUsage>): MachineView => ({
  cpu: mapOutcome(host, ({ sysctl, top }) => ({ percent: top.totalPercent, cores: sysctl.cpuCount })),
  memory: mapOutcome(host, macMemory),
  disk: mapOutcome(disk, (usage): DiskView => ({ usedBytes: usage.usedBytes, totalBytes: usage.totalBytes })),
  load: mapOutcome(host, ({ sysctl }) => sysctl.load),
  processes: zipOutcomes(host, processes, ({ sysctl, top }, rows) =>
    busiestFirst(rows.map((row) => ({ ...row, cpuPercent: (top.cpuByPid.get(row.pid) ?? 0) / sysctl.cpuCount }))),
  ),
});

const linuxMachineView = (host: Outcome<LinuxHost>, processes: Outcome<ReadonlyArray<ProcessRow>>, disk: Outcome<DiskUsage>): MachineView => ({
  cpu: mapOutcome(host, ({ cpuUsage, cpuCount }) => ({
    percent: (cpuUsage.busyJiffies / cpuUsage.totalJiffies) * 100,
    cores: cpuCount,
  })),
  memory: mapOutcome(host, ({ memory, arcReclaimableBytes }) => {
    const totalBytes = memory.MemTotal * 1024;
    const availableBytes = memory.MemAvailable * 1024 + arcReclaimableBytes;
    return {
      usedBytes:
        availableBytes <= totalBytes ? totalBytes - availableBytes : (memory.MemTotal - memory.MemFree) * 1024,
      totalBytes,
    };
  }),
  disk: mapOutcome(disk, (usage): DiskView => ({ usedBytes: usage.usedBytes, totalBytes: usage.totalBytes })),
  load: mapOutcome(host, ({ load }) => load),
  processes: mapOutcome(processes, busiestFirst),
});

export const machineView = (host: HostReading, processes: Outcome<ReadonlyArray<ProcessRow>>, disk: Outcome<DiskUsage>): MachineView =>
  host.platform === "mac" ? macMachineView(host.host, processes, disk) : linuxMachineView(host.host, processes, disk);

const measured = (metric: GpuMetric): Measured =>
  typeof metric === "number" ? { kind: "value", value: metric } : { kind: "not-reported" };

const appView =
  (processes: Outcome<ReadonlyArray<ProcessRow>>) =>
  (app: ComputeApp): GpuAppView => {
    const listed = processes.kind === "ok" ? processes.value.find((row) => row.pid === app.pid) : undefined;
    return {
      pid: app.pid,
      program: app.name === "[Not Found]" ? listed && programOf(listed.command) : programOf(app.name),
      memoryUsedMiB: measured(app.memoryUsedMiB),
    };
  };

const gpuView = (gpu: Outcome<GpuReading>, processes: Outcome<ReadonlyArray<ProcessRow>>): Outcome<GpusView> =>
  mapOutcome(gpu, ({ gpus, apps }) => ({
    gpus: gpus.map((row) => ({
      name: row.name,
      utilizationPercent: measured(row.utilizationPercent),
      memoryUsedMiB: measured(row.memoryUsedMiB),
      memoryTotalMiB: measured(row.memoryTotalMiB),
      temperatureC: measured(row.temperatureC),
    })),
    apps: mapOutcome(apps, (rows) => rows.map(appView(processes))),
  }));

export const resourcesView = (readings: ResourceReadings): ResourcesView => ({
  machine: machineView(readings.host, readings.processes, readings.disk),
  gpu: readings.gpu.kind === "unreachable" ? undefined : gpuView(readings.gpu, readings.processes),
});

export interface ReportedResources {
  readonly generatedAt: DateTime.Utc;
  readonly view: ResourcesView;
  readonly tasks: Outcome<ReadonlyArray<TaskResources>> | undefined;
}

export const machineTaskResources = (
  machine: MachineView,
  tasks: Outcome<ReportedTasks>,
  samples: Outcome<ProcessSamples>,
): Outcome<ReadonlyArray<TaskResources>> =>
  zipOutcomes(
    machine.memory,
    zipOutcomes(tasks, samples, (reported, sampled) => ({ reported, sampled })),
    (size, { reported, sampled }) => taskResources(reported.view.tasks, sampled, size),
  );

export type MachineState =
  | { readonly kind: "ok"; readonly view: ResourcesView }
  | { readonly kind: "pending" }
  | { readonly kind: "stale"; readonly generatedAt: DateTime.Utc }
  | Failed;

export interface NamedMachine {
  readonly name: string;
  readonly state: MachineState;
}

export interface MachinesView {
  readonly now: DateTime.Utc;
  readonly machines: readonly [NamedMachine, ...ReadonlyArray<NamedMachine>];
}

export interface RemoteResources {
  readonly name: string;
  readonly reading: Outcome<ReportedResources>;
}

// Both machines read again every few seconds, so an answer a minute old is a saved copy or a wrong clock.
const staleAfterMillis = 60_000;

export const isFreshResources = (generatedAt: DateTime.Utc, now: DateTime.Utc): boolean =>
  DateTime.toEpochMillis(now) - DateTime.toEpochMillis(generatedAt) <= staleAfterMillis;

const stateOf = (reading: Outcome<ReportedResources>, now: DateTime.Utc): MachineState => {
  if (reading.kind !== "ok") return reading;
  const { generatedAt, view } = reading.value;
  return isFreshResources(generatedAt, now) ? { kind: "ok", view } : { kind: "stale", generatedAt };
};

export const remoteMachine = ({ name, reading }: RemoteResources, now: DateTime.Utc): NamedMachine => ({ name, state: stateOf(reading, now) });

export const machinesView = (
  local: { readonly name: string; readonly view: ResourcesView },
  remotes: ReadonlyArray<RemoteResources>,
  now: DateTime.Utc,
): MachinesView => ({
  now,
  machines: [
    { name: local.name, state: { kind: "ok", view: local.view } },
    ...remotes.map((remote) => remoteMachine(remote, now)),
  ],
});
