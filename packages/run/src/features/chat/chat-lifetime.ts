import { Effect, FileSystem } from "effect"
import { isRunning } from "../../shared/lib/index"

const hangupExitCode = 129

export const untilHangup: Effect.Effect<number> = Effect.callback<number>((resume) => {
  const hungUp = () => resume(Effect.succeed(hangupExitCode))
  process.once("SIGHUP", hungUp)
  return Effect.sync(() => {
    process.off("SIGHUP", hungUp)
  })
})

export interface DrawerChat {
  readonly session: string
  readonly lease: string
}

export const whileDrawerOpen = Effect.fnUntraced(function*<E, R>(
  pi: Effect.Effect<number, E, R>,
  drawer: DrawerChat | null,
  ownerRunning: (pid: number) => Effect.Effect<boolean> = isRunning
) {
  if (drawer === null) return yield* pi
  const fs = yield* FileSystem.FileSystem
  const missing = () => Effect.succeed(false)
  const leaseHeld = fs.readFileString(drawer.lease).pipe(
    Effect.flatMap((owner) => /^\d+$/.test(owner.trim()) ? ownerRunning(Number(owner.trim())) : Effect.succeed(false)),
    Effect.catchReason("PlatformError", "NotFound", missing)
  )
  const sessionPresent = fs.stat(drawer.session).pipe(Effect.map(() => true), Effect.catchReason("PlatformError", "NotFound", missing))
  const open = Effect.gen(function*() {
    return (yield* leaseHeld) && (yield* sessionPresent)
  })
  if (!(yield* open)) return 0
  const untilClosed = Effect.gen(function*() {
    while (true) {
      yield* Effect.sleep("1 second")
      if (!(yield* open)) return 0
    }
  })
  return yield* Effect.raceFirst(pi, untilClosed)
})
