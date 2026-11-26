import { Effect, Layer } from "effect";
import { readConfig } from "../../entities/alerts";
import { harvestLogSourceLayer, orcQuotaSourceLayer, quotaSourceLayerWithMappings, sessionSourcesLayer, subquoProgram } from "../../entities/session-quota";

export const configuredQuotaSourceLayer = quotaSourceLayerWithMappings(
  Effect.map(readConfig, ({ config }) => config.subquoAccounts ?? []),
  subquoProgram,
);

export const quotaReadSourcesLayer = Layer.mergeAll(configuredQuotaSourceLayer, orcQuotaSourceLayer, harvestLogSourceLayer(Effect.succeed([])));

export const sessionQuotaSourcesLayer = Layer.merge(quotaReadSourcesLayer, sessionSourcesLayer);
