import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import type { NoSandboxProvider } from "@ai-hero/sandcastle"
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox"

export interface NoSandboxDirs {
  readonly piSessionDir: string
  readonly hostSessionsDir: string
}

export interface NoSandboxEnv {
  readonly GIT_CONFIG_GLOBAL: string
  readonly PI_CODING_AGENT_SESSION_DIR: string
}

// Sandcastle's per-run setup writes safe.directory and the commit identity with `git config --global`, which on the host would rewrite the operator's own config.
// No capture copies the session out of a no-sandbox run, so Pi writes it one folder below where the captured sessions sit.
export const noSandboxEnv = (dirs: NoSandboxDirs): NoSandboxEnv => ({
  GIT_CONFIG_GLOBAL: dirs.piSessionDir + "/gitconfig",
  PI_CODING_AGENT_SESSION_DIR: dirs.hostSessionsDir + "/host"
})

interface NoSandboxExecOptions {
  readonly onLine?: ((line: string) => void) | undefined
  readonly cwd?: string | undefined
  readonly stdin?: string | undefined
}

interface NoSandboxExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface NoSandboxCreateOptions {
  readonly worktreePath: string
  readonly env: Record<string, string>
}

interface NoSandboxHandle {
  readonly worktreePath: string
  readonly exec: (command: string, options?: NoSandboxExecOptions) => Promise<NoSandboxExecResult>
  readonly close: () => Promise<void>
}

type NoSandboxCreate = (options: NoSandboxCreateOptions) => Promise<NoSandboxHandle>

const signalExitCode = 128

const exitOf = (code: number | null): number => code ?? signalExitCode

const tailLimit = 65536

const appendTail = (current: string, chunk: string): string => {
  const next = current + chunk
  return next.length > tailLimit ? next.slice(next.length - tailLimit) : next
}

const fixedExec = (processEnv: Record<string, string>, fallbackCwd: string) =>
  (command: string, options?: NoSandboxExecOptions): Promise<NoSandboxExecResult> => {
    const cwd = options?.cwd ?? fallbackCwd
    const stdinText = options?.stdin
    const onLine = options?.onLine
    return new Promise<NoSandboxExecResult>((resolve, reject) => {
      const proc = spawn("sh", ["-c", command], {
        cwd,
        env: processEnv,
        stdio: [stdinText !== undefined ? "pipe" : "ignore", "pipe", "pipe"]
      })
      if (stdinText !== undefined && proc.stdin !== null) {
        proc.stdin.write(stdinText)
        proc.stdin.end()
      }
      proc.on("error", (error) => {
        reject(new Error("exec failed: " + (error instanceof Error ? error.message : String(error))))
      })
      if (onLine !== undefined) {
        let stdoutTail = ""
        let stderrTail = ""
        if (proc.stdout !== null) {
          const lines = createInterface({ input: proc.stdout })
          lines.on("line", (line) => {
            stdoutTail = appendTail(stdoutTail === "" ? "" : stdoutTail + "\n", line)
            onLine(line)
          })
        }
        if (proc.stderr !== null) {
          proc.stderr.on("data", (chunk) => {
            stderrTail = appendTail(stderrTail, chunk.toString())
          })
        }
        proc.on("close", (code) => {
          resolve({ stdout: stdoutTail, stderr: stderrTail, exitCode: exitOf(code) })
        })
      } else {
        let stdout = ""
        let stderr = ""
        if (proc.stdout !== null) {
          proc.stdout.on("data", (chunk) => {
            stdout += chunk.toString()
          })
        }
        if (proc.stderr !== null) {
          proc.stderr.on("data", (chunk) => {
            stderr += chunk.toString()
          })
        }
        proc.on("close", (code) => {
          resolve({ stdout, stderr, exitCode: exitOf(code) })
        })
      }
    })
  }

export const noSandboxProvider = (dirs: NoSandboxDirs): NoSandboxProvider => {
  const base = noSandbox({ env: { ...noSandboxEnv(dirs) } })
  const baseCreate = (base as unknown as { readonly create: NoSandboxCreate }).create.bind(base)
  const create: NoSandboxCreate = async (createOptions) => {
    const handle = await baseCreate(createOptions)
    const processEnv: Record<string, string> = { ...(process.env as Record<string, string>), ...createOptions.env }
    return {
      ...handle,
      exec: fixedExec(processEnv, handle.worktreePath)
    }
  }
  return { ...base, create } as unknown as NoSandboxProvider
}
