import { DateTime, Option } from "effect";
import type { AlertProcess, HeavyLoadEvent, HeavyLoadSettings, MachineLimits, MemoryLimit } from "../contract/alerts";
import type { ResourcesReport } from "../contract/resources";
import type { Outcome } from "../reading";
import { isFreshResources } from "../views/resources";
import { type Episode, episodeStep, type Level, type Stepped } from "./episode";

export type HeavyLoadState = ReadonlyMap<string, Episode>;

export const heavyLoadStart: HeavyLoadState = new Map();

export interface MachineResources {
  readonly name: string;
  readonly reading: Outcome<ResourcesReport>;
}

type Machine = ResourcesReport["machine"];

type Limit = HeavyLoadEvent["crossed"][number];

const usedPercentOf = ({ usedBytes, totalBytes }: { readonly usedBytes: number; readonly totalBytes: number }): number =>
  (usedBytes * 100) / totalBytes;

const memoryCrossed = (limit: MemoryLimit, usedPercent: number): boolean =>
  "usedAtLeastPercent" in limit ? usedPercent >= limit.usedAtLeastPercent : 100 - usedPercent < limit.availableUnderPercent;

const crossedOf = (machine: Machine, limits: MachineLimits): ReadonlyMap<Limit, boolean> =>
  new Map<Limit, boolean>([
    ...(machine.load.kind === "ok" ? [["load", machine.load.value[1] >= limits.loadAtLeast] as const] : []),
    ...(machine.memory.kind === "ok" ? [["memory", memoryCrossed(limits.memory, usedPercentOf(machine.memory.value))] as const] : []),
  ]);

// Load and memory each end an episode only when both read below, since an unread one may still be over.
const levelOf = (crossed: ReadonlyMap<Limit, boolean>): Level => {
  if ([...crossed.values()].some(Boolean)) return "over";
  return crossed.size === 2 ? "under" : "unknown";
};

const currentMachine = (reading: Outcome<ResourcesReport>, now: DateTime.Utc): Machine | undefined =>
  reading.kind === "ok" && Option.exists(DateTime.make(reading.value.generatedAt), (generatedAt) => isFreshResources(DateTime.toUtc(generatedAt), now))
    ? reading.value.machine
    : undefined;

const topBy = (processes: ReadonlyArray<AlertProcess>, size: (process: AlertProcess) => number, count: number) =>
  processes.toSorted((a, b) => size(b) - size(a)).slice(0, count);

const eventOf = (
  name: string,
  machine: Machine,
  limits: MachineLimits,
  crossed: ReadonlyMap<Limit, boolean>,
  since: number,
  at: DateTime.Utc,
  topProcesses: number,
): HeavyLoadEvent => {
  const processes = machine.processes.kind === "ok" ? machine.processes.value : [];
  return {
    schemaVersion: 1,
    rule: "heavy-load",
    at: DateTime.formatIso(at),
    machine: name,
    since: DateTime.formatIso(DateTime.makeUnsafe(since)),
    crossed: [...crossed].flatMap(([limit, over]) => (over ? [limit] : [])),
    limits,
    load: machine.load.kind === "ok" ? machine.load.value : null,
    memory: machine.memory.kind === "ok" ? { ...machine.memory.value, usedPercent: usedPercentOf(machine.memory.value) } : null,
    topProcesses: {
      byCpu: topBy(processes, (process) => process.cpuPercent, topProcesses),
      byMemory: topBy(processes, (process) => process.residentBytes, topProcesses),
    },
  };
};

// A machine the sample leaves out, could not read or read over a minute ago keeps its episode, since only a reading below every limit ends one.
export const heavyLoadStep = (
  state: HeavyLoadState,
  sample: Outcome<ReadonlyArray<MachineResources>>,
  now: DateTime.Utc,
  settings: HeavyLoadSettings,
): Stepped<HeavyLoadState, HeavyLoadEvent> => {
  if (sample.kind !== "ok") return { state, events: [] };
  const next = new Map(state);
  const events: Array<HeavyLoadEvent> = [];
  for (const { name, reading } of sample.value) {
    const limits = settings.machines.find((machine) => machine.name === name);
    if (limits === undefined) continue;
    const machine = currentMachine(reading, now);
    const crossed = machine === undefined ? new Map<Limit, boolean>() : crossedOf(machine, limits);
    const step = episodeStep(next.get(name), levelOf(crossed), DateTime.toEpochMillis(now), settings.sustainedMinutes * 60_000);
    if (step.episode === undefined) next.delete(name);
    else next.set(name, step.episode);
    if (step.fire && step.episode !== undefined && machine !== undefined)
      events.push(eventOf(name, machine, limits, crossed, step.episode.since, now, settings.topProcesses));
  }
  return { state: next, events };
};
