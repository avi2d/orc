import { BunFileSystem } from "@effect/platform-bun";
import { Layer } from "effect";
import { configuredQuotaSourceLayer, harvestLogSourceLayer, orcQuotaSourceLayer, readClaudeAccounts, sessionLogSourceLayer, sessionSourcesLayer } from "@avi2dg/orc-schema";
import { liveCommandRunner } from "@avi2dg/orc-ui";

const livePlatform = Layer.merge(liveCommandRunner, BunFileSystem.layer);

export const sessionLogSourceLive = sessionLogSourceLayer.pipe(Layer.provide(BunFileSystem.layer));

export const harvestLogSourceLive = harvestLogSourceLayer(readClaudeAccounts).pipe(Layer.provide(BunFileSystem.layer));

export const sessionSourcesLive = sessionSourcesLayer.pipe(Layer.provide(livePlatform));

export const sessionQuotaSourcesLive = Layer.mergeAll(
  configuredQuotaSourceLayer,
  orcQuotaSourceLayer,
  harvestLogSourceLayer(readClaudeAccounts),
  sessionSourcesLayer,
).pipe(Layer.provide(livePlatform));
