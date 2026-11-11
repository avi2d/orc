import { BunFileSystem } from "@effect/platform-bun";
import { Layer } from "effect";
import { dispatchSourceLayer } from "@avi2dg/orc-schema";
import { liveCommandRunner } from "@avi2dg/orc-ui";

export const dispatchSourcesLive = dispatchSourceLayer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, liveCommandRunner)));
