import { Layer } from "effect";
import { actionsSourceLayer, pueueMachinesLayer } from "@tui-dash/schema";
import { liveCommandRunner } from "@tui-dash/ui";

export const queueSourcesLive = Layer.mergeAll(pueueMachinesLayer, actionsSourceLayer).pipe(Layer.provide(liveCommandRunner));
