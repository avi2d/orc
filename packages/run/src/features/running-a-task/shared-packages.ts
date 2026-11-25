import { Effect, type FileSystem, type Path } from "effect"

interface SharedGitSource {
  readonly own: string
  readonly shared: string
}

const protocolUrl = /^(https?|ssh|git):\/\//i

const hostAndPathWithRef = (url: string): { readonly host: string; readonly pathWithRef: string } | null => {
  const scpLike = /^git@([^:]+):(.+)$/.exec(url)
  if (scpLike !== null) {
    return { host: scpLike[1], pathWithRef: scpLike[2] }
  }
  if (protocolUrl.test(url)) {
    const parsed = URL.parse(url)
    return parsed === null ? null : { host: parsed.hostname, pathWithRef: parsed.pathname.replace(/^\/+/, "") }
  }
  const slash = url.indexOf("/")
  const host = url.slice(0, slash)
  return slash < 0 || !(host.includes(".") || host === "localhost") ? null : { host, pathWithRef: url.slice(slash + 1) }
}

const isSafePart = (part: string): boolean => part !== "" && part !== "." && part !== ".." && !part.includes("\\") && !part.includes("\0") && !part.includes("%")

// Pi installs a pinned git source at <agent dir>/git/<host>/<path> and never fetches it again, while an unpinned one follows its branch only through a fresh clone, so only a pinned source is shared.
// A source read here differently from Pi is never shared, since no install appears at the path this names.
const pinnedInstallParts = (source: string): ReadonlyArray<string> | null => {
  const prefixed = source.startsWith("git:")
  const url = prefixed ? source.slice("git:".length).trim() : source
  if (!prefixed && !protocolUrl.test(url)) {
    return null
  }
  const located = hostAndPathWithRef(url)
  const at = located === null ? -1 : located.pathWithRef.indexOf("@")
  if (located === null || at <= 0 || at === located.pathWithRef.length - 1) {
    return null
  }
  const parts = [located.host, ...located.pathWithRef.slice(0, at).replace(/\.git$/, "").split("/")]
  return parts.length < 3 || !parts.every(isSafePart) ? null : parts
}

export const sharedGitSources = (path: Path.Path, orcHome: string, piAgentDir: string, packages: ReadonlyArray<string>): ReadonlyArray<SharedGitSource> =>
  [...new Set(packages.map((source) => source.trim()))].flatMap((source) => {
    const parts = pinnedInstallParts(source)
    if (parts === null) {
      return []
    }
    const key = new Bun.CryptoHasher("sha256").update(source).digest("hex").slice(0, 16)
    return [{ own: path.join(piAgentDir, "git", ...parts), shared: path.join(orcHome, "pi-packages", key) }]
  })

const isLink = (fs: FileSystem.FileSystem, file: string): Effect.Effect<boolean> =>
  fs.readLink(file).pipe(Effect.as(true), Effect.orElseSucceed(() => false))

const exists = (fs: FileSystem.FileSystem, file: string): Effect.Effect<boolean> =>
  fs.exists(file).pipe(Effect.orElseSucceed(() => false))

const linkOne = (fs: FileSystem.FileSystem, path: Path.Path, source: SharedGitSource): Effect.Effect<void> =>
  Effect.gen(function*() {
    if (!(yield* exists(fs, source.shared)) || (yield* isLink(fs, source.own)) || (yield* exists(fs, source.own))) {
      return
    }
    yield* fs.makeDirectory(path.dirname(source.own), { recursive: true }).pipe(Effect.orElseSucceed(() => undefined))
    yield* fs.symlink(source.shared, source.own).pipe(Effect.orElseSucceed(() => undefined))
  })

export const linkSharedGit = (fs: FileSystem.FileSystem, path: Path.Path, sources: ReadonlyArray<SharedGitSource>): Effect.Effect<void> =>
  Effect.forEach(sources, (source) => linkOne(fs, path, source), { discard: true })

// Pi removes the folder of a source that failed to install, so a folder that exists holds a whole install.
// A rename is atomic, so of two runs that installed the same source at once one becomes the cache and the other links to it.
const shareOne = (fs: FileSystem.FileSystem, path: Path.Path, source: SharedGitSource): Effect.Effect<void> =>
  Effect.gen(function*() {
    if ((yield* isLink(fs, source.own)) || !(yield* exists(fs, source.own))) {
      return
    }
    yield* fs.makeDirectory(path.dirname(source.shared), { recursive: true }).pipe(Effect.orElseSucceed(() => undefined))
    yield* fs.rename(source.own, source.shared).pipe(Effect.orElseSucceed(() => undefined))
    if (!(yield* exists(fs, source.shared))) {
      return
    }
    yield* fs.remove(source.own, { recursive: true, force: true }).pipe(Effect.orElseSucceed(() => undefined))
    yield* fs.symlink(source.shared, source.own).pipe(Effect.orElseSucceed(() => undefined))
  })

export const shareInstalledGit = (fs: FileSystem.FileSystem, path: Path.Path, sources: ReadonlyArray<SharedGitSource>): Effect.Effect<void> =>
  Effect.forEach(sources, (source) => shareOne(fs, path, source), { discard: true })
