import { Data, Effect, Option, Path, Schema } from "effect"
import { createRequire } from "node:module"

class SubquoMissing extends Data.TaggedError("SubquoMissing")<{ readonly from: string }> {}

const Manifest = Schema.Struct({ version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/u)) })

const decodeManifest = Schema.decodeUnknownOption(Manifest)

const missing = (from: string) => (): SubquoMissing => new SubquoMissing({ from })

const resolvedFrom = (base: string, request: string): Effect.Effect<string, SubquoMissing> =>
  Effect.try({ try: () => createRequire(base).resolve(request), catch: missing(base) })

const installedSubquo = (base: string, platform: string, arch: string): Effect.Effect<Option.Option<string>, never, Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const root = yield* resolvedFrom(base, "@avi2dg/subquo/package.json")
    const manifest = decodeManifest(yield* Effect.tryPromise({ try: (): Promise<unknown> => Bun.file(root).json(), catch: missing(root) }))
    if (Option.isNone(manifest)) return Option.none()
    const platformPackage = yield* resolvedFrom(root, "@avi2dg/subquo-" + platform + "-" + arch + "/package.json")
    const binary = path.join(path.dirname(platformPackage), "subquo-" + manifest.value.version)
    const present = yield* Effect.tryPromise({ try: () => Bun.file(binary).exists(), catch: missing(binary) })
    return present ? Option.some(binary) : Option.none()
  }).pipe(Effect.catchTag("SubquoMissing", () => Effect.succeedNone))

export const subquoProgram = (bases: ReadonlyArray<string>): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function*() {
    for (const base of bases) {
      const installed = yield* installedSubquo(base, process.platform, process.arch)
      if (Option.isSome(installed)) return installed.value
    }
    return "subquo"
  })
