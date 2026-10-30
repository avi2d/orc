import { Layer } from "effect";
import { queueSourcesLive } from "@tui-dash/queues";
import { resourceSourcesLive } from "@tui-dash/resources";
import { sessionQuotaSourcesLive } from "@tui-dash/session-quota";
import { ciRunsLayer, machineSchedulesLayer, runnerReposLayer, tasksMachinesLayer } from "@tui-dash/schema";
import { liveCommandRunner } from "@tui-dash/ui";

export const snapshotSourcesLive = Layer.mergeAll(
  sessionQuotaSourcesLive,
  resourceSourcesLive,
  queueSourcesLive,
  tasksMachinesLayer.pipe(Layer.provide(liveCommandRunner)),
);

const onMac = process.platform === "darwin";

export const alertCommandLive = Layer.mergeAll(
  snapshotSourcesLive,
  Layer.mergeAll(ciRunsLayer, machineSchedulesLayer(onMac ? "mac" : "linux")).pipe(Layer.provideMerge(runnerReposLayer)),
).pipe(Layer.provide(liveCommandRunner));
