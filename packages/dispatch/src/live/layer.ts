import { BunFileSystem } from "@effect/platform-bun";
import { Layer } from "effect";
import { dispatchSourceLayer } from "@tui-dash/schema";

export const dispatchSourcesLive = dispatchSourceLayer.pipe(Layer.provide(BunFileSystem.layer));
