import { Layer } from "effect";
import { actionsSourceLayer, pueueMachinesLayer } from "@avi2dg/orc-schema";
import { liveCommandRunner } from "@avi2dg/orc-ui";

export const queueSourcesLive = Layer.mergeAll(pueueMachinesLayer, actionsSourceLayer).pipe(Layer.provide(liveCommandRunner));
