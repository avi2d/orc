import { BunFileSystem } from "@effect/platform-bun";
import { Layer } from "effect";
import { dispatchSourceLayer } from "@avi2dg/orc-schema";

export const dispatchSourcesLive = dispatchSourceLayer.pipe(Layer.provide(BunFileSystem.layer));
