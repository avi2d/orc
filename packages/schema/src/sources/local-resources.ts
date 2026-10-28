import { DateTime, Effect, Layer } from "effect";
import { type MachinesView, machinesView, resourcesView, type ResourcesView } from "../views/resources";
import { LinuxDiskSource, linuxDiskSourceLayer, MacDiskSource, macDiskSourceLayer } from "./disk";
import { GpuSource, gpuSourceLayer } from "./gpu";
import { LinuxHostSource, linuxHostSourceLayer } from "./linux-host";
import { MacHostSource, macHostSourceLayer } from "./mac-host";
import { readBeside } from "./machines";
import { LinuxProcessesSource, linuxProcessesSourceLayer, MacProcessesSource, macProcessesSourceLayer } from "./processes";
import { ResourceMachines } from "./remote-resources";

export type HostSources = MacHostSource | MacProcessesSource | MacDiskSource | LinuxHostSource | LinuxProcessesSource | LinuxDiskSource | GpuSource;

export const hostSourcesLayer = Layer.mergeAll(
  macHostSourceLayer,
  macProcessesSourceLayer,
  macDiskSourceLayer,
  linuxHostSourceLayer,
  linuxProcessesSourceLayer,
  linuxDiskSourceLayer,
  gpuSourceLayer,
);

export const readLocalResources: Effect.Effect<ResourcesView, never, HostSources> = Effect.gen(function* () {
  const gpu = yield* GpuSource;
  if (process.platform === "darwin") {
    const host = yield* MacHostSource;
    const processes = yield* MacProcessesSource;
    const disk = yield* MacDiskSource;
    const read = yield* Effect.all({ host: host.read, processes: processes.read, gpu: gpu.read, disk: disk.read }, { concurrency: "unbounded" });
    return resourcesView({ ...read, host: { platform: "mac", host: read.host } });
  }
  const host = yield* LinuxHostSource;
  const processes = yield* LinuxProcessesSource;
  const disk = yield* LinuxDiskSource;
  const read = yield* Effect.all({ host: host.read, processes: processes.read, gpu: gpu.read, disk: disk.read }, { concurrency: "unbounded" });
  return resourcesView({ ...read, host: { platform: "linux", host: read.host } });
});

export const readMachines: Effect.Effect<MachinesView, never, HostSources | ResourceMachines> = Effect.gen(function* () {
  const configured = yield* ResourceMachines;
  const [local, remotes] = yield* readBeside(readLocalResources, configured);
  return machinesView({ name: configured.local, view: local }, remotes, yield* DateTime.now);
});
