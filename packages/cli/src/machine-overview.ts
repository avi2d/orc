import { DateTime, Effect } from "effect";
import { type MachineReport, readMachineReports } from "@avi2dg/orc-resources";
import { mapOutcome, type Outcome, type ResourcesReport } from "@avi2dg/orc-schema";
import { runningOrcByMachine } from "./running-orc";

interface MachineOverview<Runs> {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly sources: {
    readonly resources: {
      readonly status: "ok";
      readonly machines: ReadonlyArray<{
        readonly name: string;
        readonly reading: Outcome<{ readonly machine: Pick<ResourcesReport["machine"], "cpu" | "load" | "memory" | "disk"> }>;
      }>;
    };
    readonly queues: { readonly status: "ok"; readonly machines: ReadonlyArray<{ readonly name: string; readonly runs: Runs }> };
  };
}

export const machineOverviewDocument = <Runs>(
  machines: ReadonlyArray<MachineReport>,
  counts: ReadonlyArray<{ readonly name: string; readonly runs: Runs }>,
  generatedAt: string,
): MachineOverview<Runs> => ({
  schemaVersion: 1,
  generatedAt,
  sources: {
    resources: {
      status: "ok",
      machines: machines.map(({ name, reading }) => ({
        name,
        reading: mapOutcome(reading, ({ machine: { cpu, load, memory, disk } }) => ({
          machine: disk === undefined ? { cpu, load, memory } : { cpu, load, memory, disk },
        })),
      })),
    },
    queues: { status: "ok", machines: counts },
  },
});

export const machineOverview = Effect.gen(function* () {
  const [machines, counts] = yield* Effect.all([readMachineReports, runningOrcByMachine], { concurrency: "unbounded" });
  return machineOverviewDocument(machines, counts, DateTime.formatIso(yield* DateTime.now));
});
