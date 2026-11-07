import { Layer } from "effect";
import { queueSourcesLive } from "@tui-dash/queues";
import { resourceSourcesLive } from "@tui-dash/resources";
import { sessionQuotaSourcesLive } from "@tui-dash/session-quota";
import { tasksMachinesLayer } from "@tui-dash/schema";
import { liveCommandRunner } from "@tui-dash/ui";

export const snapshotSourcesLive = Layer.mergeAll(
  sessionQuotaSourcesLive,
  resourceSourcesLive,
  queueSourcesLive,
  tasksMachinesLayer.pipe(Layer.provide(liveCommandRunner)),
);


