import { Effect, Equal, FileSystem } from "effect"
import { isRunning } from "../../shared/lib/index"

const sameFile = (a: FileSystem.File.Info, b: FileSystem.File.Info): boolean => a.dev === b.dev && Equal.equals(a.ino, b.ino)

const hangupExitCode = 129

export const untilHangup: Effect.Effect<number> = Effect.callback<number>((resume) => {
  const hungUp = () => resume(Effect.succeed(hangupExitCode))
  process.once("SIGHUP", hungUp)
  return Effect.sync(() => {
    process.off("SIGHUP", hungUp)
  })
})

export const whileSessionExists = Effect.fnUntraced(function*<E, R>(
  pi: Effect.Effect<number, E, R>,
  session: string | null,
  drawerLease: string | null,
  ownerRunning: (pid: number) => Effect.Effect<boolean> = isRunning
) {
  if (session === null && drawerLease === null) return yield* pi
  const fs = yield* FileSystem.FileSystem
  const stat = (path: string) => fs.stat(path).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)))
  const leaseHeld = drawerLease === null ? Effect.succeed(true) : fs.readFileString(drawerLease).pipe(
    Effect.flatMap((owner) => /^\d+$/.test(owner.trim()) ? ownerRunning(Number(owner.trim())) : Effect.succeed(false)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false))
  )
  if (!(yield* leaseHeld)) return 0
  let original = session === null ? null : yield* stat(session)
  if (drawerLease !== null && original === null) return 0
  const untilEnded = Effect.gen(function*() {
    while (true) {
      yield* Effect.sleep("1 second")
      if (!(yield* leaseHeld)) return 0
      if (session === null) continue
      const present = yield* stat(session)
      if (original !== null && (present === null || !sameFile(original, present))) return 0
      original ??= present
    }
  })
  return yield* Effect.raceFirst(pi, untilEnded)
})
