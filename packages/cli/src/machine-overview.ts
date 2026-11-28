import { DateTime, Effect } from "effect";
import { readMachineReports } from "@avi2dg/orc-resources";
import { mapOutcome } from "@avi2dg/orc-schema";
import { runningOrcByMachine } from "./running-orc";

export const machineOverview = Effect.gen(function* () {
  const [machines, counts] = yield* Effect.all([readMachineReports, runningOrcByMachine], { concurrency: "unbounded" });
  return {
    schemaVersion: 1,
    generatedAt: DateTime.formatIso(yield* DateTime.now),
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
  };
});
