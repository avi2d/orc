import { Effect, Stream } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import type { CommandResult } from "./checks"
import { runHostCommand } from "./host"
import { OrcRunError } from "./run-session"

type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"]

type Env = Readonly<Record<string, string>>

export type Argv = readonly [string, ...Array<string>]

export type AgentExec =
  | { readonly kind: "none"; readonly cwd: string; readonly env: Env }
  | { readonly kind: "nono"; readonly cwd: string; readonly env: Env; readonly nonoBinary: string; readonly profilePath: string }

export const sandboxedEnvNames: ReadonlyArray<string> = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM"]

export const hostEnvNames: ReadonlyArray<string> = [
  ...sandboxedEnvNames,
  "SHELL",
  "TMPDIR",
  "PI_CODING_AGENT_DIR",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy"
]

export const pickEnv = (hostEnv: Readonly<Record<string, string | undefined>>, names: ReadonlyArray<string>): Record<string, string> =>
  Object.fromEntries(names.flatMap((name) => {
    const value = hostEnv[name]
    return value === undefined ? [] : [[name, value]]
  }))

// A dependency missing from the copy would otherwise be fetched by bare bun on the fly, so the copy would run code its lockfile never named.
export const agentEnv = (base: Env, extra: Env): Env =>
  Object.fromEntries(Object.entries({ ...base, ...extra, BUN_OPTIONS: "--no-install" }).filter(([name]) => !name.startsWith("ORC_")))

export const hostExec = (cwd: string, hostEnv: Readonly<Record<string, string | undefined>>, extra: Env): AgentExec =>
  ({ kind: "none", cwd, env: agentEnv(pickEnv(hostEnv, hostEnvNames), extra) })

export const nonoRunArgs = (profilePath: string, argv: Argv): ReadonlyArray<string> => ["run", "--silent", "--profile", profilePath, "--", ...argv]

export const agentCommand = (exec: AgentExec, argv: Argv, stdin: ChildProcess.CommandInput = "ignore"): ChildProcess.Command => {
  const options = { cwd: exec.cwd, env: exec.env, extendEnv: false, stdin, forceKillAfter: "1 second" } as const
  return exec.kind === "none"
    ? ChildProcess.make(argv[0], argv.slice(1), options)
    : ChildProcess.make(exec.nonoBinary, [...nonoRunArgs(exec.profilePath, argv)], options)
}

export const shellInAgent = (
  spawner: Spawner,
  exec: AgentExec,
  command: string,
  onLine?: (line: string) => void
): Effect.Effect<CommandResult, OrcRunError> =>
  runHostCommand(spawner, agentCommand(exec, ["sh", "-c", command]), { onLine }).pipe(
    Effect.map(({ stdout, stderr, exitCode }) => ({ stdout, stderr, exitCode })),
    Effect.mapError((cause) => new OrcRunError({ message: "orc: " + command + " did not run: " + cause.message }))
  )

export const textInput = (text: string): ChildProcess.CommandInput => Stream.fromIterable([new TextEncoder().encode(text)])
