import { Layer } from "effect";
import { queueSourcesLive } from "@avi2dg/orc-queues";
import { resourceSourcesLive } from "@avi2dg/orc-resources";
import { sessionQuotaSourcesLive } from "@avi2dg/orc-session-quota";
import { tasksMachinesLayer } from "@avi2dg/orc-schema";
import { liveCommandRunner } from "@avi2dg/orc-ui";

export const snapshotSourcesLive = Layer.mergeAll(
  sessionQuotaSourcesLive,
  resourceSourcesLive,
  queueSourcesLive,
  tasksMachinesLayer.pipe(Layer.provide(liveCommandRunner)),
);


