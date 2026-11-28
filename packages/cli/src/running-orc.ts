import { Duration, Effect, Schema } from "effect";
import { decodeJson, decodePueue, mapOutcome, outcomeOf, type PueueStatus, PueueMachines, runDecoded, selector } from "@avi2dg/orc-schema";

import { peerReport, preferPeerReport } from "./peer-report";

const RunningOrc = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  count: outcomeOf(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const runningOrcCount = (status: PueueStatus): number =>
  Object.values(status.tasks).filter((task) => task.group === "orc" && "Running" in task.status).length;

export const localRunningOrc = Effect.map(
  runDecoded({ argv: ["pueue", "status", "--json", "status=running"], timeout: Duration.seconds(10) }, decodePueue),
  (status) => ({ schemaVersion: 1, count: mapOutcome(status, runningOrcCount) }) satisfies typeof RunningOrc.Type,
);

const decodeCount = (text: string) => {
  const report = decodeJson(RunningOrc)(text);
  return report.kind === "ok" ? report.value.count : report;
};

export const runningOrcByMachine = Effect.gen(function* () {
  const machines = yield* PueueMachines;
  const command = yield* selector("ORC_DASH_REMOTE_PUEUE");
  const quota = yield* selector("ORC_DASH_REMOTE_SESSION_QUOTA");
  return yield* Effect.forEach(machines, (machine, index) => {
    const legacy = Effect.map(machine.read, (reading) => mapOutcome(reading, runningOrcCount));
    const count = index === 0 ? Effect.map(localRunningOrc, (report) => report.count)
      : preferPeerReport(peerReport("running-orc", command, quota), Duration.seconds(20), decodeCount, legacy);
    return Effect.map(count, (runs) => ({ name: machine.name, runs }));
  }, { concurrency: "unbounded" });
});
