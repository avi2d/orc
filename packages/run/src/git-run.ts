import { Effect, type PlatformError, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { hostGitRefusalExit, hostGitSafetyEnv } from "./host"
import type { OrcRunCommit } from "./report"
import { OrcRunError } from "./run-session"

const gitEnv = (): Record<string, string> => ({
  PATH: Bun.env.PATH ?? "",
  HOME: Bun.env.HOME ?? "",
  ...hostGitSafetyEnv,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1"
})

export const collectOutput = (
  handle: ChildProcessSpawner.ChildProcessHandle
): Effect.Effect<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }, PlatformError.PlatformError> =>
  Effect.all({
    stdout: handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
    stderr: handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
    exitCode: handle.exitCode
  }, { concurrency: "unbounded" })

export const branchCommits = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  git: string,
  branch: string,
  projectDir: string
): Effect.Effect<Array<OrcRunCommit>, OrcRunError> =>
  runGit(spawner, git, ["log", branch, "--not", "HEAD", "--format=%H%x1f%s"], projectDir).pipe(
    Effect.map((logged) => {
      if (logged.exitCode !== 0) {
        return []
      }
      return logged.stdout.split("\n").filter((line) => line.trim() !== "").map((line) => {
        const cut = line.indexOf("\x1f")
        return cut === -1 ? { sha: line.trim(), subject: "" } : { sha: line.slice(0, cut).trim(), subject: line.slice(cut + 1).trim() }
      })
    }),
    Effect.orElseSucceed(() => [] as Array<OrcRunCommit>)
  )

export const runGit = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  git: string,
  args: ReadonlyArray<string>,
  cwd: string
): Effect.Effect<{ readonly stdout: string; readonly exitCode: number }, OrcRunError> =>
  Effect.scoped(Effect.gen(function*() {
    const handle = yield* spawner.spawn(ChildProcess.make(git, [...args], { cwd, env: gitEnv(), extendEnv: false }))
    const { stdout, stderr, exitCode } = yield* collectOutput(handle)
    if (exitCode === hostGitRefusalExit) {
      return yield* new OrcRunError({ message: stderr.trim() })
    }
    return { stdout, exitCode }
  })).pipe(
    Effect.mapError((cause) => cause instanceof OrcRunError ? cause : new OrcRunError({ message: "orc: git failed to run: " + String(cause) }))
  )
