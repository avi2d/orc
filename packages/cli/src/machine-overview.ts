import { DateTime, Effect } from "effect";
import { type MachineReport, readMachineReports } from "@avi2dg/orc-resources";
import { mapOutcome } from "@avi2dg/orc-schema";
import { runningOrcByMachine } from "./running-orc";

export const machineOverviewDocument = <Runs>(
  machines: ReadonlyArray<MachineReport>,
  counts: ReadonlyArray<{ readonly name: string; readonly runs: Runs }>,
  generatedAt: string,
) => ({
  schemaVersion: 1,
  generatedAt,
  sources: {
    resources: {
      status: "ok",
      machines: machines.map(({ name, reading }) => ({
        name,
        reading: mapOutcome(reading, ({ machine: { cpu, load, memory, disk } }) => ({ machine: { cpu, load, memory, disk } })),
      })),
    },
    queues: { status: "ok", machines: counts },
  },
});

export const machineOverview = Effect.gen(function* () {
  const [machines, counts] = yield* Effect.all([readMachineReports, runningOrcByMachine], { concurrency: "unbounded" });
  return machineOverviewDocument(machines, counts, DateTime.formatIso(yield* DateTime.now));
});
