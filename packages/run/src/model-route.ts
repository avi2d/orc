import { Effect, FileSystem, Result } from "effect"
import type { OrcConfig, Provider, TokenFileLocation } from "./orc-config"
import { OrcRunError } from "./run-session"

export const tokenFileVar = "ORC_TOKEN_FILE"

// A literal key here would leave the token in the run's Pi folder.
export const tokenFileApiKey = "!cat \"$" + tokenFileVar + "\""

const providerOf = (model: string): string => {
  const slash = model.indexOf("/")
  return slash === -1 ? model : model.slice(0, slash)
}

export const routeOfAgents = (
  config: OrcConfig,
  models: { readonly agent: string; readonly fixer: string },
  pinned: string | undefined
): Result.Result<Provider, string> => {
  const agentProvider = config.providers.find((candidate) => candidate.id === providerOf(models.agent))
  const fixerProvider = config.providers.find((candidate) => candidate.id === providerOf(models.fixer))
  if (agentProvider === undefined || fixerProvider === undefined) {
    return Result.fail("orc: " + config.file + " does not configure the provider for an agent model, so add it to the providers there")
  }
  if (pinned !== undefined && providerOf(models.agent) !== pinned) {
    return Result.fail("orc: --provider names " + pinned + ", and the implementer runs on model " + models.agent + ", so the run would hand its credential to another provider; name a model from " + pinned + " or drop the flag")
  }
  if (providerOf(models.fixer) !== agentProvider.id) {
    return Result.fail("orc: the implementer runs on " + models.agent + " and the fixer on " + models.fixer + ", and orc runs both agents of a run on one provider, so name models from one provider")
  }
  return Result.succeed(agentProvider)
}

export interface TokenFileSource {
  readonly path: string | undefined
  readonly origin: string
}

export const tokenFileSource = (
  location: TokenFileLocation,
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  configFile: string
): TokenFileSource => {
  if (flag !== undefined) {
    return { path: flag, origin: "--token-file" }
  }
  return "env" in location
    ? { path: env[location.env], origin: "the variable " + location.env }
    : { path: location.path, origin: configFile }
}

const ownerOnly = (mode: number): boolean => (mode & 0o077) === 0

export const requireTokenFile = (fs: FileSystem.FileSystem, model: string, source: TokenFileSource): Effect.Effect<string, OrcRunError> =>
  Effect.gen(function*() {
    const refuse = (why: string) => Effect.fail(new OrcRunError({ message: "orc: the implementer runs on model " + model + ", " + why }))
    const tokenFile = source.path
    if (tokenFile === undefined || tokenFile === "") {
      return yield* refuse("and its provider takes its token only from the file " + source.origin + " names, which is unset")
    }
    if (!tokenFile.startsWith("/")) {
      return yield* refuse("and " + source.origin + " names " + tokenFile + ", which is not an absolute path")
    }
    const info = yield* fs.stat(tokenFile).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot read the token file " + tokenFile + ": " + cause.message }))
    )
    if (info.type !== "File") {
      return yield* refuse("and the token file " + tokenFile + " is not a regular file")
    }
    if (!ownerOnly(info.mode)) {
      return yield* refuse("and the token file " + tokenFile + " has mode " + (info.mode & 0o777).toString(8) + ", which lets other users read it, so make it readable only by its owner")
    }
    if (Number(info.size) === 0) {
      return yield* refuse("and the token file " + tokenFile + " is empty")
    }
    return tokenFile
  })
