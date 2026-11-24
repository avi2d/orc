import { Effect, type FileSystem, type Path } from "effect"

export const toolTimeCap = (fs: FileSystem.FileSystem, path: Path.Path, home: string) =>
  fs.realPath(path.join(home, ".pi", "agent", "extensions", "tool-time-cap.ts")).pipe(
    Effect.map((file): string | null => file),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null))
  )
