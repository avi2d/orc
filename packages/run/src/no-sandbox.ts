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

export const noSandboxProvider = (dirs: NoSandboxDirs): NoSandboxProvider => noSandbox({ env: { ...noSandboxEnv(dirs) } })
