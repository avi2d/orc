import { Data, Effect, FileSystem, Path, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"

export class AppInstallError extends Data.TaggedError("AppInstallError")<{
  readonly detail: string
}> {}

export const bundledAppDir = (): string => import.meta.dir + "/../dist/herdr-app"

export const appHomeDir = (home: string): string => home + "/.config/herdr-app"

const KeysFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const KeysSection = Schema.Record(Schema.String, Schema.Unknown)

type Keys = Readonly<Record<string, Readonly<Record<string, unknown>>>>

interface KeyEntry {
  readonly section: string
  readonly key: string
}

interface SkippedKey extends KeyEntry {
  readonly kept: unknown
}

export interface KeysMerge {
  readonly keys: Readonly<Record<string, unknown>>
  readonly added: ReadonlyArray<KeyEntry>
  readonly skipped: ReadonlyArray<SkippedKey>
}

export interface AppInstall {
  readonly home: string
  readonly mods: ReadonlyArray<string>
  readonly layouts: ReadonlyArray<string>
  readonly added: ReadonlyArray<KeyEntry>
  readonly skipped: ReadonlyArray<SkippedKey>
}

const isOrcName = (name: string): boolean => name.startsWith("orc")

const sectionOf = (keys: Readonly<Record<string, unknown>>, section: string): Effect.Effect<Readonly<Record<string, unknown>>, AppInstallError> =>
  keys[section] === undefined
    ? Effect.succeed({})
    : Schema.decodeUnknownEffect(KeysSection)(keys[section]).pipe(
      Effect.mapError(() => new AppInstallError({ detail: `keys.json holds ${section} as no object of keys, so fix it by hand first` }))
    )

export const mergeKeys = (
  mine: Readonly<Record<string, unknown>>,
  ours: Keys
): Effect.Effect<KeysMerge, AppInstallError> =>
  Effect.gen(function*() {
    const keys: Record<string, unknown> = { ...mine }
    const added: Array<KeyEntry> = []
    const skipped: Array<SkippedKey> = []
    for (const [section, bindings] of Object.entries(ours)) {
      const merged: Record<string, unknown> = { ...(yield* sectionOf(mine, section)) }
      for (const [key, action] of Object.entries(bindings)) {
        if (merged[key] === undefined) {
          merged[key] = action
          added.push({ section, key })
        } else if (JSON.stringify(merged[key]) !== JSON.stringify(action)) {
          skipped.push({ section, key, kept: merged[key] })
        }
      }
      keys[section] = merged
    }
    return { keys, added, skipped }
  })

const fail = (detail: string) => (cause: PlatformError) => new AppInstallError({ detail: `${detail}: ${cause.message}` })

const keepInstallError = (detail: string) => (cause: unknown) =>
  cause instanceof AppInstallError ? cause : fail(detail)(cause as PlatformError)

const readKeysText = (fs: FileSystem.FileSystem, file: string, missingDetail: string): Effect.Effect<Readonly<Record<string, unknown>>, AppInstallError> =>
  fs.readFileString(file).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.fail(new AppInstallError({ detail: missingDetail }))),
    Effect.mapError(keepInstallError(`cannot read ${file}`)),
    Effect.flatMap((text) => Schema.decodeEffect(KeysFile)(text).pipe(
      Effect.mapError(() => new AppInstallError({ detail: `${file} holds no JSON object, so fix it by hand first` }))
    ))
  )

const readUserKeys = (fs: FileSystem.FileSystem, file: string): Effect.Effect<Readonly<Record<string, unknown>>, AppInstallError> =>
  readKeysText(fs, file, `cannot read ${file}, so run the Herdr App once first`)

const readBundledKeys = (fs: FileSystem.FileSystem, file: string): Effect.Effect<Keys, AppInstallError> =>
  readKeysText(fs, file, `cannot read the built Herdr App keys at ${file}, so run bun run build first`).pipe(
    Effect.flatMap((keys) => Effect.forEach(Object.keys(keys), (section) => sectionOf(keys, section).pipe(Effect.map((bindings) => [section, bindings] as const)))),
    Effect.map((sections) => Object.fromEntries(sections))
  )

const orcEntries = (fs: FileSystem.FileSystem, dir: string): Effect.Effect<ReadonlyArray<string>, AppInstallError> =>
  fs.readDirectory(dir).pipe(
    Effect.mapError(fail(`cannot read the built Herdr App files at ${dir}, so run bun run build first`)),
    Effect.flatMap((names) => {
      const foreign = names.filter((name) => !isOrcName(name))
      return foreign.length === 0
        ? Effect.succeed(names.toSorted())
        : Effect.fail(new AppInstallError({ detail: `${dir} holds ${foreign.join(", ")}, and orc installs only names that start with orc` }))
    })
  )

const replace = (fs: FileSystem.FileSystem, from: string, to: string): Effect.Effect<void, AppInstallError> =>
  fs.remove(to, { recursive: true, force: true }).pipe(
    Effect.andThen(fs.copy(from, to)),
    Effect.mapError(fail(`cannot copy ${from} to ${to}`))
  )

export const installApp = (source: string, home: string): Effect.Effect<AppInstall, AppInstallError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const mods = yield* orcEntries(fs, path.join(source, "mods"))
    const layouts = yield* orcEntries(fs, path.join(source, "layouts"))
    const ours = yield* readBundledKeys(fs, path.join(source, "keys.json"))
    const keysFile = path.join(home, "keys.json")
    const merge = yield* mergeKeys(yield* readUserKeys(fs, keysFile), ours)
    for (const dir of ["mods", "layouts"]) {
      yield* fs.makeDirectory(path.join(home, dir), { recursive: true }).pipe(Effect.mapError(fail(`cannot create ${path.join(home, dir)}`)))
    }
    for (const mod of mods) {
      yield* replace(fs, path.join(source, "mods", mod), path.join(home, "mods", mod))
    }
    for (const layout of layouts) {
      yield* replace(fs, path.join(source, "layouts", layout), path.join(home, "layouts", layout))
    }
    if (merge.added.length > 0) {
      yield* fs.writeFileString(keysFile, JSON.stringify(merge.keys, null, 2) + "\n").pipe(Effect.mapError(fail(`cannot write ${keysFile}`)))
    }
    return { home, mods, layouts, added: merge.added, skipped: merge.skipped }
  })

export const formatAppInstall = (install: AppInstall): string => [
  `orc app install: copied the mods ${install.mods.join(", ")} into ${install.home}/mods`,
  `orc app install: copied ${install.layouts.join(", ")} into ${install.home}/layouts`,
  ...install.added.map((entry) => `orc app install: added ${entry.key} to ${entry.section} in keys.json`),
  ...install.skipped.map((entry) => `orc app install: skipped ${entry.key} in ${entry.section}, which keys.json already sets to ${JSON.stringify(entry.kept)}`),
  `orc app install: show it with herdr-app do layout.switch '{"name":"orc"}', and your layout.switch key brings back your own layout`
].join("\n")
