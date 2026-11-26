import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { harvestLogSourceLayer, orcQuotaSourceLayer, quotaSourceLayerWithMappings, readClaudeAccounts, readConfig, sessionLogSourceLayer, sessionSourcesLayer, subquoProgram } from "@avi2dg/orc-schema";
import { liveCommandRunner } from "@avi2dg/orc-ui";

const livePlatform = Layer.merge(liveCommandRunner, BunFileSystem.layer);

export const sessionLogSourceLive = sessionLogSourceLayer.pipe(Layer.provide(BunFileSystem.layer));

export const harvestLogSourceLive = harvestLogSourceLayer(readClaudeAccounts).pipe(Layer.provide(BunFileSystem.layer));

export const sessionSourcesLive = sessionSourcesLayer.pipe(Layer.provide(livePlatform));

export const sessionQuotaSourcesLive = Layer.mergeAll(
  quotaSourceLayerWithMappings(Effect.map(readConfig, ({ config }) => config.subquoAccounts ?? []), subquoProgram),
  orcQuotaSourceLayer,
  harvestLogSourceLayer(readClaudeAccounts),
  sessionSourcesLayer,
).pipe(Layer.provide(livePlatform));
