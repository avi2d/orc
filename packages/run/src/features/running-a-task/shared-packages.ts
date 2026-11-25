import { Effect, type FileSystem, type Path } from "effect"

const isGitSource = (source: string): boolean => !source.startsWith("npm:") && !source.startsWith("/")

// Pi keeps a git source at <agent dir>/git/<host>/<path> whatever its ref, so the cache is keyed by the sources to keep two refs apart.
export const sharedGitDir = (path: Path.Path, orcHome: string, packages: ReadonlyArray<string>): string | null => {
  const sources = [...new Set(packages.filter(isGitSource))].sort()
  if (sources.length === 0) {
    return null
  }
  const key = new Bun.CryptoHasher("sha256").update(sources.join("\n")).digest("hex").slice(0, 16)
  return path.join(orcHome, "pi-packages", key, "git")
}

const isLink = (fs: FileSystem.FileSystem, file: string): Effect.Effect<boolean> =>
  fs.readLink(file).pipe(Effect.as(true), Effect.orElseSucceed(() => false))

const exists = (fs: FileSystem.FileSystem, file: string): Effect.Effect<boolean> =>
  fs.exists(file).pipe(Effect.orElseSucceed(() => false))

export const linkSharedGit = (fs: FileSystem.FileSystem, path: Path.Path, shared: string | null, piAgentDir: string): Effect.Effect<void> =>
  Effect.gen(function*() {
    const own = path.join(piAgentDir, "git")
    if (shared === null || !(yield* exists(fs, shared)) || (yield* isLink(fs, own)) || (yield* exists(fs, own))) {
      return
    }
    yield* fs.symlink(shared, own).pipe(Effect.orElseSucceed(() => undefined))
  })

// A rename is atomic, so of two runs that installed the same sources at once one becomes the cache and the other links to it.
export const shareInstalledGit = (fs: FileSystem.FileSystem, path: Path.Path, shared: string | null, piAgentDir: string): Effect.Effect<void> =>
  Effect.gen(function*() {
    const own = path.join(piAgentDir, "git")
    if (shared === null || (yield* isLink(fs, own)) || !(yield* exists(fs, own))) {
      return
    }
    yield* fs.makeDirectory(path.dirname(shared), { recursive: true }).pipe(Effect.orElseSucceed(() => undefined))
    yield* fs.rename(own, shared).pipe(Effect.orElseSucceed(() => undefined))
    if (!(yield* exists(fs, shared))) {
      return
    }
    yield* fs.remove(own, { recursive: true, force: true }).pipe(Effect.orElseSucceed(() => undefined))
    yield* fs.symlink(shared, own).pipe(Effect.orElseSucceed(() => undefined))
  })
