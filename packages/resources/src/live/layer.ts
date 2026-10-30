import { Layer } from "effect";
import {
  hostSourcesLayer,
  linuxTaskProcessesSourceLayer,
  localTasksLayer,
  macTaskProcessesSourceLayer,
  resourceMachinesLayer,
} from "@tui-dash/schema";
import { liveCommandRunner } from "@tui-dash/ui";

const taskProcessesSourceLayer = process.platform === "darwin" ? macTaskProcessesSourceLayer : linuxTaskProcessesSourceLayer;

export const resourceSourcesLive = Layer.mergeAll(hostSourcesLayer, resourceMachinesLayer, localTasksLayer, taskProcessesSourceLayer).pipe(
  Layer.provide(liveCommandRunner),
);
