import { BunFileSystem } from "@effect/platform-bun";
import { Layer } from "effect";
import { harvestLogSourceLayer, readClaudeAccounts, sessionLogSourceLayer, sessionQuotaSourcesLayer, sessionSourcesLayer } from "@tui-dash/schema";
import { liveCommandRunner } from "@tui-dash/ui";

const livePlatform = Layer.merge(liveCommandRunner, BunFileSystem.layer);

export const sessionLogSourceLive = sessionLogSourceLayer.pipe(Layer.provide(BunFileSystem.layer));

export const harvestLogSourceLive = harvestLogSourceLayer(readClaudeAccounts).pipe(Layer.provide(BunFileSystem.layer));

export const sessionSourcesLive = sessionSourcesLayer.pipe(Layer.provide(livePlatform));

export const sessionQuotaSourcesLive = sessionQuotaSourcesLayer.pipe(Layer.provide(livePlatform));
