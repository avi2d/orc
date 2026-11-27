import { Effect, type FileSystem, type Path, Result } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { backlogPaths, backlogRoot } from "../../entities/backlog/index"
import { type ProviderRoom, readDispatchConfig } from "../../shared/config/index"
import { readQuota, roomOnProvider } from "./quota"

export const readProviderRoom = (
  orcHome: string,
  provider: string
): Effect.Effect<ProviderRoom, never, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const config = yield* readDispatchConfig(backlogPaths(backlogRoot(orcHome)).dispatchConfig).pipe(Effect.result)
    if (Result.isFailure(config)) {
      return { kind: "no-room", reason: "orc cannot read " + config.failure.file + ": " + config.failure.detail } satisfies ProviderRoom
    }
    const reading = yield* readQuota(config.success.quota)
    return roomOnProvider(reading, config.success.quota, provider)
  })
