import { Layer } from "effect";
import {
  hostSourcesLayer,
  linuxTaskProcessesSourceLayer,
  localTasksLayer,
  macTaskProcessesSourceLayer,
  resourceMachinesLayer,
} from "@avi2dg/orc-schema";
import { liveCommandRunner } from "@avi2dg/orc-ui";

const taskProcessesSourceLayer = process.platform === "darwin" ? macTaskProcessesSourceLayer : linuxTaskProcessesSourceLayer;

export const resourceSourcesLive = Layer.mergeAll(hostSourcesLayer, resourceMachinesLayer, localTasksLayer, taskProcessesSourceLayer).pipe(
  Layer.provide(liveCommandRunner),
);
