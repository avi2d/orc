import { Effect, Layer } from "effect";
import { readConfig } from "../../entities/alerts";
import { harvestLogSourceLayer, orcQuotaSourceLayer, quotaSourceLayerWithMappings, sessionSourcesLayer } from "../../entities/session-quota";

const subquoMappings = Effect.map(readConfig, ({ config }) => config.subquoAccounts ?? []).pipe(
  Effect.catchTag("ConfigRefused", (refused) =>
    Effect.as(Effect.logError(`The subquo account mappings are not read: ${refused.reason}`), []),
  ),
);

export const configuredQuotaSourceLayer = quotaSourceLayerWithMappings(subquoMappings);

export const quotaReadSourcesLayer = Layer.mergeAll(configuredQuotaSourceLayer, orcQuotaSourceLayer, harvestLogSourceLayer(Effect.succeed([])));

export const sessionQuotaSourcesLayer = Layer.merge(quotaReadSourcesLayer, sessionSourcesLayer);
