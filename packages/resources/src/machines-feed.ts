import { DateTime, Effect, Option, type Scope } from "effect";
import {
  type Freshness,
  type HostSources,
  machinesCadence,
  MachinesCodec,
  type MachinesView,
  type NamedMachine,
  type Outcome,
  polled,
  readLocalResources,
  refreshingOf,
  remoteMachine,
  type ReportedResources,
  ResourceMachines,
  type ResourcesView,
  SavedReadings,
  type Shown,
  type Stamped,
} from "@tui-dash/schema";

export interface MachinesShown {
  readonly shown: Shown<MachinesView>;
  readonly answered: boolean;
  readonly freshness: ReadonlyArray<Freshness>;
}

interface FreshMachines {
  readonly local: Option.Option<Stamped<ResourcesView>>;
  readonly remotes: ReadonlyArray<{ readonly name: string; readonly reading: Option.Option<Stamped<Outcome<ReportedResources>>> }>;
}

type MachineRead = "live" | "saved" | "pending";

// Each machine shows its own answer once it lands, and until then its saved copy, so a slow machine never holds another back.
const machinesShown = (local: string, fresh: FreshMachines, saved: Option.Option<Stamped<MachinesView>>, now: DateTime.Utc): MachinesShown => {
  const answers: ReadonlyArray<{ readonly name: string; readonly machine: Option.Option<Stamped<NamedMachine>> }> = [
    { name: local, machine: Option.map(fresh.local, ({ value: view, at }) => ({ value: { name: local, state: { kind: "ok", view } }, at })) },
    ...fresh.remotes.map(({ name, reading }) => ({
      name,
      machine: Option.map(reading, ({ value: answer, at }) => ({ value: remoteMachine({ name, reading: answer }, now), at })),
    })),
  ];
  const savedOf = (name: string) => (Option.isSome(saved) ? saved.value.value.machines.find((machine) => machine.name === name) : undefined);
  const shown = answers.map(({ name, machine }): { readonly machine: NamedMachine; readonly read: MachineRead; readonly at?: number } => {
    if (Option.isSome(machine)) return { machine: machine.value.value, read: "live", at: machine.value.at };
    const copy = savedOf(name);
    return copy === undefined ? { machine: { name, state: { kind: "pending" } }, read: "pending" } : { machine: copy, read: "saved" };
  });
  const [first, ...rest] = shown.map(({ machine }) => machine);
  const answered = shown.every(({ read }) => read === "live");
  if (shown.every(({ read }) => read === "pending")) return { shown: { kind: "pending" }, answered, freshness: [] };
  const liveFreshness: ReadonlyArray<Freshness> = shown.flatMap(({ read, at }) =>
    read !== "live" || at === undefined ? [] : [{ at, kind: "live" as const }],
  );
  const value: MachinesView = { now, machines: [first, ...rest] };
  const standsIn = Option.isSome(saved) && shown.some(({ read }) => read === "saved");
  const liveAt = Math.min(...shown.flatMap(({ at }) => (at === undefined ? [] : [at])));
  if (standsIn) {
    const at = saved.value.at;
    return { shown: { kind: "saved", value, at }, answered, freshness: [{ at, kind: "saved" }] };
  }
  return { shown: { kind: "live", value, at: liveAt }, answered, freshness: liveFreshness };
};

export const machinesFeed: Effect.Effect<{ readonly read: Effect.Effect<MachinesShown>; readonly refreshing: Effect.Effect<boolean> }, never, HostSources | ResourceMachines | SavedReadings | Scope.Scope> = Effect.gen(
  function* () {
    const configured = yield* ResourceMachines;
    const local = yield* polled(readLocalResources, machinesCadence);
    const remotes = yield* Effect.forEach(configured.remotes, (remote) => Effect.map(polled(remote.read, machinesCadence), (poll) => ({ name: remote.name, poll })));
    const slot = (yield* SavedReadings).slot("machines", MachinesCodec);
    const last = yield* Effect.cached(slot.last);
    const read = Effect.gen(function* () {
      const fresh: FreshMachines = yield* Effect.all(
        {
          local: local.latest,
          remotes: Effect.forEach(remotes, ({ name, poll }) => Effect.map(poll.latest, (reading) => ({ name, reading })), { concurrency: "unbounded" }),
        },
        { concurrency: "unbounded" },
      );
      const now = yield* DateTime.now;
      const machines = machinesShown(configured.local, fresh, yield* last, now);
      // Only a view every machine answered is saved, so a saved copy never claims an age younger than one of its machines.
      if (machines.answered && machines.shown.kind === "live") yield* slot.keep(machines.shown.value, machines.shown.at);
      return machines;
    });
    return { read, refreshing: refreshingOf([local, ...remotes.map(({ poll }) => poll)]) };
  },
);
