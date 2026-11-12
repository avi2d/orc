import { Console, Effect, type FileSystem, type Path, type Scope } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { type AgentExec, hostExec, shellInAgent } from "./shared/sandbox/index"
import { prepareCommandOf, readChecksCommands } from "./checks"
import { commitsSince, headOf } from "./shared/process/index"
import { openNonoExec } from "./shared/sandbox/index"
import type { ToolchainResolver } from "./shared/sandbox/index"
import { runPi, type PiPacing } from "./entities/agent/index"
import type { RunFolders } from "./run-folders"
import type { SandboxOps } from "./run-loop"
import { OrcRunError } from "./shared/lib/index"
import type { SandboxPlan } from "./sandbox-plan"

type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"]

export const agentGitConfig = (folders: Pick<RunFolders, "piSessionDir">): string => folders.piSessionDir + "/gitconfig"

export const openAgentExec = (
  plan: SandboxPlan,
  folders: RunFolders,
  copyDir: string,
  toolchain: ToolchainResolver,
  hostEnv: Readonly<Record<string, string | undefined>>
): Effect.Effect<AgentExec, OrcRunError, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  plan.kind === "none"
    ? Effect.succeed(hostExec(copyDir, hostEnv, {
      GIT_CONFIG_GLOBAL: agentGitConfig(folders),
      ...(plan.own === null ? {} : { PI_CODING_AGENT_DIR: plan.own.piAgentDir, ...plan.own.env })
    }))
    : openNonoExec({
      worktree: copyDir,
      piSessionDir: folders.piSessionDir,
      sessionsDir: folders.hostSessionsDir,
      piAgentDir: folders.piAgentDir,
      modelCredential: plan.credential,
      hostEnv,
      toolchain,
      env: {}
    }).pipe(Effect.mapError((cause) => new OrcRunError({ message: "orc: the sandbox failed to start: " + cause.message })))

// Pi runs bun with --no-install, so a copy left without its dependencies fails on the first import instead of reaching the main checkout's.
export const installCopy = (
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  exec: AgentExec,
  logFile: string
): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const file = path.join(exec.cwd, ".no-mistakes.yaml")
    const text = yield* fs.readFileString(file).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed<string | null>(null)),
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot read " + file + ": " + String(cause) }))
    )
    const commands = text === null ? [] : yield* readChecksCommands(text, file).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: cause.message }))
    )
    const prepare = prepareCommandOf(commands)
    if (prepare === null) {
      return
    }
    yield* Console.log("orc: preparing the copy with " + prepare)
    const result = yield* shellInAgent(spawner, exec, prepare)
    yield* fs.writeFileString(logFile, "$ " + prepare + "\n" + result.stdout + result.stderr + "exit " + result.exitCode.toString() + "\n").pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write " + logFile + ": " + String(cause) }))
    )
    if (result.exitCode !== 0) {
      return yield* new OrcRunError({ message: "orc: " + prepare + " exited " + result.exitCode.toString() + " in the copy " + exec.cwd + ", so Pi did not start; its output is in " + logFile })
    }
  })

export const agentOps = (
  run: { readonly spawner: Spawner; readonly fs: FileSystem.FileSystem; readonly path: Path.Path; readonly git: string },
  exec: AgentExec,
  folders: RunFolders,
  pacing: PiPacing
): SandboxOps => ({
  runAgent: (agentRun) =>
    Effect.gen(function*() {
      const base = yield* headOf(run.spawner, run.git, exec.cwd)
      const pi = yield* runPi(run.spawner, run.fs, run.path, exec, {
        agent: agentRun.agent,
        prompt: agentRun.prompt,
        instructions: folders.instructionsPath,
        sessionDir: folders.hostSessionsDir,
        resumeSession: agentRun.resumeSession,
        logFile: run.path.join(folders.runDir, agentRun.logFile),
        onSession: agentRun.onSession
      }, pacing)
      const commits = yield* commitsSince(run.spawner, run.git, exec.cwd, base)
      return { ...pi, commits }
    }),
  execCheck: (command) => shellInAgent(run.spawner, exec, command)
})
