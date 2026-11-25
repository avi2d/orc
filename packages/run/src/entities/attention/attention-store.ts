import { Effect, FileSystem, Option, Schema } from "effect"
import { withFileClaim } from "../../shared/lib/index"
import { BacklogError, platformFailure, publishOnce, readIfPresent, scratchName, writeAtomic } from "../backlog/index"
import { AttentionItem, type Asked } from "./attention-item"

const ItemFile = Schema.fromJsonString(AttentionItem)

export const fileSuffix = ".json"

export const attentionFolder = (root: string): string => root + "/attention"

const itemFile = (root: string, id: string): string => attentionFolder(root) + "/" + id + fileSuffix

export const encodeItem = (id: string, item: AttentionItem): Effect.Effect<string, BacklogError> =>
  Schema.encodeEffect(ItemFile)(item).pipe(Effect.mapError((error) => new BacklogError({ detail: "cannot write the item " + id + ": " + error.message })))

export const withItemClaim = <A>(root: string, id: string, change: Effect.Effect<A, BacklogError, FileSystem.FileSystem>): Effect.Effect<A, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const file = attentionFolder(root) + "/." + id + ".lock"
    const attempt = withFileClaim(file, change).pipe(
      Effect.catchTag("PlatformError", (error) => Effect.fail(platformFailure("claim " + file)(error)))
    )
    for (let attempts = 0; attempts < 100; attempts += 1) {
      const result = yield* attempt
      if (Option.isSome(result)) {
        return result.value
      }
      yield* Effect.sleep("20 millis")
    }
    return yield* new BacklogError({ detail: "cannot change attention item " + id + ": its write lock is held" })
  })

export const writeItem = (root: string, id: string, encoded: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  writeAtomic(scratchName(attentionFolder(root), id), itemFile(root, id), encoded)

export const replaceItem = (root: string, id: string, before: string, encoded: string): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  withItemClaim(root, id, Effect.gen(function*() {
    if ((yield* readIfPresent(itemFile(root, id))) !== before) {
      return false
    }
    yield* writeItem(root, id, encoded)
    return true
  }))

export const openItem = (root: string, id: string, asked: Asked): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const folder = attentionFolder(root)
    yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(platformFailure("make " + folder)))
    return yield* publishOnce(folder, id + fileSuffix, yield* encodeItem(id, { ...asked, state: { kind: "open" } }))
  })

export const readExistingItem = (root: string, id: string): Effect.Effect<{ readonly before: string; readonly item: AttentionItem } | null, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const file = itemFile(root, id)
    const before = yield* readIfPresent(file)
    if (before === null) {
      return null
    }
    const item = yield* Schema.decodeEffect(ItemFile)(before).pipe(Effect.mapError((error) => new BacklogError({ detail: file + " holds no item orc reads: " + error.message })))
    return { before, item }
  })

export const readItem = (root: string, id: string): Effect.Effect<AttentionItem | null, BacklogError, FileSystem.FileSystem> =>
  Effect.map(readExistingItem(root, id), (existing) => existing?.item ?? null)
