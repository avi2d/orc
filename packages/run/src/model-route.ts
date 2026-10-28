import { Effect, FileSystem, Result } from "effect"
import { canRouteModel } from "./nono-profile"
import { OrcRunError } from "./run-session"

export type ModelRoute = "opencode-go" | "claude"

export const claudeProvider = "anthropic"

export const claudeTokenFileVar = "ORC_CLAUDE_TOKEN_FILE"

// A literal key here would leave the login in the run's Pi folder.
export const claudeApiKey = "!cat \"$" + claudeTokenFileVar + "\""

const providerOf = (model: string): string => {
  const slash = model.indexOf("/")
  return slash === -1 ? model : model.slice(0, slash)
}

const modelRouteOf = (model: string): ModelRoute | null => {
  if (canRouteModel(model)) {
    return "opencode-go"
  }
  return providerOf(model) === claudeProvider ? "claude" : null
}

export const routeOfAgents = (models: { readonly agent: string; readonly fixer: string }): Result.Result<ModelRoute, string> => {
  const route = modelRouteOf(models.agent)
  if (route === null) {
    return Result.fail("orc: the agent file names model " + models.agent + ", and orc routes only opencode-go and anthropic models")
  }
  if (modelRouteOf(models.fixer) !== route) {
    return Result.fail("orc: the implementer runs on " + models.agent + " and the fixer on " + models.fixer + ", and orc routes both agents of a run the same way, so name models from one provider")
  }
  return Result.succeed(route)
}

const ownerOnly = (mode: number): boolean => (mode & 0o077) === 0

export const requireClaudeTokenFile = (fs: FileSystem.FileSystem, model: string, tokenFile: string | undefined): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const refuse = (why: string) => Effect.fail(new OrcRunError({ message: "orc: the agent file names model " + model + ", " + why }))
    if (tokenFile === undefined || tokenFile === "") {
      return yield* refuse("and a Claude run takes its token only from the file " + claudeTokenFileVar + " names, which is unset")
    }
    if (!tokenFile.startsWith("/")) {
      return yield* refuse("and " + claudeTokenFileVar + " names " + tokenFile + ", which is not an absolute path")
    }
    const info = yield* fs.stat(tokenFile).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot read the Claude token file " + tokenFile + ": " + cause.message }))
    )
    if (info.type !== "File") {
      return yield* refuse("and the Claude token file " + tokenFile + " is not a regular file")
    }
    if (!ownerOnly(info.mode)) {
      return yield* refuse("and the Claude token file " + tokenFile + " has mode " + (info.mode & 0o777).toString(8) + ", which lets other users read it, so make it readable only by its owner")
    }
    if (Number(info.size) === 0) {
      return yield* refuse("and the Claude token file " + tokenFile + " is empty")
    }
  })
