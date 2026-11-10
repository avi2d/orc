import { Effect, FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { readOrcConfig } from "../orc-config"
import { heavyBinDir, resolveHeavy, type HeavySettings } from "./heavy"
import { detectWrap, standinScripts, type HeavyPlatform, type StandinSettings } from "./heavy-standin"
import { RunnerError } from "./runner-error"
import { ensureGroup } from "./runner"

const platformOf = (): HeavyPlatform =>
  process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "other"

export const readHeavySettings = (home: string): Effect.Effect<HeavySettings, RunnerError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const config = yield* readOrcConfig(home).pipe(
      Effect.mapError((error) => new RunnerError({ detail: error.file + ": " + error.detail }))
    )
    return resolveHeavy(config.heavy)
  })

const ensureHeavyGroup = (settings: HeavySettings): Effect.Effect<void, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  ensureGroup(settings.group, ["--parallel", "1"])

export const writeHeavyBin = (
  home: string,
  settings: HeavySettings,
  platform: HeavyPlatform
): Effect.Effect<ReadonlyArray<string>, RunnerError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const bin = heavyBinDir(home)
    const wrap = detectWrap(platform, settings.limit)
    const standins: StandinSettings = { home, group: settings.group, wrap, through: settings.through }
    const scripts = standinScripts(standins, settings.commands)
    yield* fs.makeDirectory(bin, { recursive: true }).pipe(
      Effect.mapError((error) => new RunnerError({ detail: "cannot write " + bin + ": " + error.message }))
    )
    const tools = Object.keys(scripts)
    const kept = new Set(tools)
    const present = yield* fs.readDirectory(bin).pipe(
      Effect.mapError((error) => new RunnerError({ detail: "cannot read " + bin + ": " + error.message }))
    )
    for (const entry of present) {
      if (!kept.has(entry) && !entry.includes(".pending-")) {
        yield* fs.remove(bin + "/" + entry).pipe(
          Effect.mapError((error) => new RunnerError({ detail: "cannot remove " + bin + "/" + entry + ": " + error.message }))
        )
      }
    }
    for (const tool of tools) {
      const file = bin + "/" + tool
      const script = scripts[tool] ?? ""
      const staging = file + ".pending-" + process.pid
      yield* fs.writeFileString(staging, script).pipe(
        Effect.andThen(fs.chmod(staging, 0o755)),
        Effect.andThen(fs.rename(staging, file)),
        Effect.mapError((error) => new RunnerError({ detail: "cannot write " + file + ": " + error.message }))
      )
    }
    return tools
  })

export const ensureHeavyQueue = (home: string, settings: HeavySettings): Effect.Effect<ReadonlyArray<string>, RunnerError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    if (settings.through === null && (Bun.env.HEAVY_QUEUE_BYPASS ?? "").trim() === "") {
      yield* ensureHeavyGroup(settings)
    }
    return yield* writeHeavyBin(home, settings, platformOf())
  })

export const ensureHeavySetup = (home: string): Effect.Effect<ReadonlyArray<string>, RunnerError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    return yield* ensureHeavyQueue(home, yield* readHeavySettings(home))
  })
