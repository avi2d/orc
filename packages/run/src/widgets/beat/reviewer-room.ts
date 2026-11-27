import { Effect, type FileSystem, type Path, Result } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { backlogPaths, backlogRoot } from "../../entities/backlog/index"
import { defaultCredentialOf, readDispatchConfig, readOrcConfig, type ProviderRoom, type RoomReading } from "../../shared/config/index"
import { readQuota, roomOnCredential } from "./quota"
import type { ReviewerRoomCheck } from "../../features/queueing-a-task/index"
import { pickChainEntry } from "../../features/running-a-task/index"

export const readReviewerRoom = (
  orcHome: string
): Effect.Effect<RoomReading, never, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const config = yield* readDispatchConfig(backlogPaths(backlogRoot(orcHome)).dispatchConfig).pipe(Effect.result)
    if (Result.isFailure(config)) {
      const reason = "orc cannot read " + config.failure.file + ": " + config.failure.detail
      const noRoom: RoomReading = () => ({ kind: "no-room", reason })
      return noRoom
    }
    const { quota } = config.success
    const reading = yield* readQuota(quota)
    const roomOf: RoomReading = (reviewer) => roomOnCredential(reading, quota, reviewer)
    return roomOf
  })

export const checkReviewerRoom: ReviewerRoomCheck = (home, implementerProviders) =>
  Effect.gen(function*() {
    const config = yield* readOrcConfig(home)
    if (config.reviewers === undefined) {
      return { kind: "no-room", reason: "orc needs a reviewer chain in config.json before it can resume" } satisfies ProviderRoom
    }
    const roomOf = yield* readReviewerRoom(home)
    const providers = new Map(config.providers.map((provider) => [provider.id, provider]))
    yield* pickChainEntry(config.reviewers, implementerProviders, ({ provider }) => {
      const configured = providers.get(provider)
      return configured === undefined
        ? { kind: "no-room", reason: "the reviewer provider is not configured" }
        : roomOf({ provider, credential: defaultCredentialOf(configured, Bun.env, config.file) })
    })
    return { kind: "room" } satisfies ProviderRoom
  }).pipe(
    Effect.catchTags({
      ConfigError: (error) => Effect.succeed<ProviderRoom>({ kind: "no-room", reason: "orc cannot read " + error.file + ": " + error.detail }),
      NoReviewerRoom: (error) => Effect.succeed<ProviderRoom>({ kind: "no-room", reason: error.message })
    })
  )
