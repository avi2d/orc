import { Effect, FileSystem, Option, Result, Schema } from "effect"

export type Env = Readonly<Record<string, string | undefined>>

const setIn = (env: Env, name: string): string | null => {
  const value = env[name] ?? ""
  return value === "" ? null : value
}

const homeIn = (env: Env): string => setIn(env, "HOME") ?? ""

// Pueue takes its folders from the dirs crate, which reads the XDG variables on Linux and ignores them on macOS.
const configFolder = (env: Env, platform: NodeJS.Platform): string =>
  platform === "darwin" ? homeIn(env) + "/Library/Application Support" : setIn(env, "XDG_CONFIG_HOME") ?? homeIn(env) + "/.config"

const dataFolder = (env: Env, platform: NodeJS.Platform): string =>
  platform === "darwin" ? homeIn(env) + "/Library/Application Support" : setIn(env, "XDG_DATA_HOME") ?? homeIn(env) + "/.local/share"

export const pueueConfigFile = (env: Env, platform: NodeJS.Platform): string =>
  setIn(env, "PUEUE_CONFIG_PATH") ?? configFolder(env, platform) + "/pueue/pueue.yml"

const PueueConfig = Schema.Struct({ shared: Schema.Struct({ pueue_directory: Schema.String.check(Schema.isNonEmpty()) }) })

const decodeConfig = Schema.decodeUnknownOption(PueueConfig)

const configuredFolder = (text: string, env: Env): string | null => {
  const parsed = Result.try((): unknown => Bun.YAML.parse(text))
  if (Result.isFailure(parsed)) {
    return null
  }
  return Option.match(decodeConfig(parsed.success), {
    onNone: () => null,
    onSome: ({ shared: { pueue_directory: folder } }) => folder === "~" || folder.startsWith("~/") ? homeIn(env) + folder.slice(1) : folder
  })
}

export const pueueFolder = (configText: string | null, env: Env, platform: NodeJS.Platform): string =>
  (configText === null ? null : configuredFolder(configText, env)) ?? dataFolder(env, platform) + "/pueue"

// A log pueue has not written, or a folder orc resolved wrong, reads as null, so the beat never calls a run stalled on a guess.
export const pueueOutputAt = (id: number, env: Env, platform: NodeJS.Platform): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const configText = yield* fs.readFileString(pueueConfigFile(env, platform)).pipe(Effect.orElseSucceed(() => null))
    const info = yield* fs.stat(pueueFolder(configText, env, platform) + "/task_logs/" + id + ".log").pipe(Effect.orElseSucceed(() => null))
    return info === null ? null : Option.match(info.mtime, { onNone: () => null, onSome: (mtime) => mtime.toISOString() })
  })
