import { Console, Effect, type FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { backlogPaths, backlogRoot } from "../entities/backlog/index"
import { type ConfigError, readDispatchConfig } from "../shared/config/index"
import { describeQuota, readQuota } from "../widgets/beat/index"

export const runQuotaCli = (
  home: string,
  json: boolean
): Effect.Effect<void, ConfigError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const config = yield* readDispatchConfig(backlogPaths(backlogRoot(home)).dispatchConfig)
    const reading = yield* readQuota(config.quota)
    yield* Console.log(json ? JSON.stringify(reading) : describeQuota(reading))
  })
