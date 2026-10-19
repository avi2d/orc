import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { hostGitRefusalExit, hostGitSafetyEnv } from "./host"
import { OrcRunError } from "./run-session"

const gitEnv = (): Record<string, string> => ({
  PATH: Bun.env.PATH ?? "",
  HOME: Bun.env.HOME ?? "",
  ...hostGitSafetyEnv,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1"
})

export const runGit = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  git: string,
  args: ReadonlyArray<string>,
  cwd: string
): Effect.Effect<{ readonly stdout: string; readonly exitCode: number }, OrcRunError> =>
  Effect.scoped(Effect.gen(function*() {
    const handle = yield* spawner.spawn(ChildProcess.make(git, [...args], { cwd, env: gitEnv(), extendEnv: false }))
    const [stdout, stderr, exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" })
    if (exitCode === hostGitRefusalExit) {
      return yield* new OrcRunError({ message: stderr.trim() })
    }
    return { stdout, exitCode }
  })).pipe(
    Effect.mapError((cause) => cause instanceof OrcRunError ? cause : new OrcRunError({ message: "orc: git failed to run: " + String(cause) }))
  )
