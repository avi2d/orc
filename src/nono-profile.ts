/**
 * Pure nono profile and environment builders for the orc sandbox provider.
 * Everything here is a value the provider builds its profile and child
 * environment from, with no process spawning, so unit tests cover it
 * without nesting a sandbox.
 */

/** The three writable directory roots of an orc agent sandbox. */
export interface NonoSandboxRoots {
  readonly worktree: string
  readonly gitData: string
  readonly piSessionDir: string
}

/** A nono profile document as orc writes it for one sandbox. */
export interface NonoProfile {
  readonly meta: {
    readonly name: string
    readonly description: string
  }
  readonly extends: "default"
  readonly groups: {
    readonly include: ReadonlyArray<string>
    readonly exclude: ReadonlyArray<string>
  }
  readonly security: {
    readonly signal_mode: "isolated"
    readonly capability_elevation: false
  }
  readonly filesystem: {
    readonly allow: ReadonlyArray<string>
    readonly read: ReadonlyArray<string>
    readonly write: ReadonlyArray<string>
    readonly allow_file: ReadonlyArray<string>
    readonly read_file: ReadonlyArray<string>
    readonly write_file: ReadonlyArray<string>
    readonly unix_socket: ReadonlyArray<string>
    readonly unix_socket_bind: ReadonlyArray<string>
    readonly unix_socket_dir: ReadonlyArray<string>
    readonly unix_socket_dir_bind: ReadonlyArray<string>
    readonly unix_socket_subtree: ReadonlyArray<string>
    readonly unix_socket_subtree_bind: ReadonlyArray<string>
    readonly deny: ReadonlyArray<string>
    readonly bypass_protection: ReadonlyArray<string>
    readonly suppress_save_prompt: ReadonlyArray<string>
  }
  readonly network: {
    readonly block: true
    readonly allow_domain: ReadonlyArray<string>
    readonly credentials: ReadonlyArray<string>
    readonly open_port: ReadonlyArray<number>
    readonly listen_port: ReadonlyArray<number>
    readonly no_proxy: ReadonlyArray<string>
    readonly upstream_bypass: ReadonlyArray<string>
  }
  readonly workdir: {
    readonly access: "readwrite"
  }
}

const nonoGroups: ReadonlyArray<string> = [
  "node_runtime",
  "bun_runtime",
  "mise_manager",
  "nix_runtime",
  "git_config",
  "unlink_protection"
]

const nonoExcludedGroups: ReadonlyArray<string> = ["system_write_macos", "system_write_linux"]

/** Build the nono profile for one sandbox from its three writable roots. */
export const buildNonoProfile = (roots: NonoSandboxRoots): NonoProfile => ({
  meta: {
    name: "orc-nono-agent",
    description: "orc agent sandbox: the isolated copy, its git data and Pi's session folder"
  },
  extends: "default",
  groups: {
    include: nonoGroups,
    exclude: nonoExcludedGroups
  },
  security: {
    signal_mode: "isolated",
    capability_elevation: false
  },
  filesystem: {
    allow: [roots.worktree, roots.gitData, roots.piSessionDir],
    read: [],
    write: ["/dev"],
    allow_file: [],
    read_file: [],
    write_file: [],
    unix_socket: [],
    unix_socket_bind: [],
    unix_socket_dir: [],
    unix_socket_dir_bind: [],
    unix_socket_subtree: [],
    unix_socket_subtree_bind: [],
    deny: [],
    bypass_protection: [],
    suppress_save_prompt: ["/"]
  },
  network: {
    block: true,
    allow_domain: [],
    credentials: [],
    open_port: [],
    listen_port: [],
    no_proxy: [],
    upstream_bypass: []
  },
  workdir: {
    access: "readwrite"
  }
})

/** Inputs for one `nono run` invocation wrapping a sandboxed command. */
export interface NonoCommandInput {
  readonly nonoBinary: string
  readonly profilePath: string
  readonly command: string
}

/** Build the argv that runs one command inside the sandbox. */
export const buildNonoArgv = (input: NonoCommandInput): readonly [string, ...Array<string>] => [
  input.nonoBinary,
  "run",
  "--silent",
  "--profile",
  input.profilePath,
  "--allow-cwd",
  "--",
  "sh",
  "-c",
  input.command
]

const githubCredentialVars: ReadonlyArray<string> = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN"
]

/** Copy an env mapping without any GitHub credential variable. */
export const scrubGitHubCredentials = (
  env: Record<string, string | undefined>
): Record<string, string | undefined> => {
  const scrubbed: Record<string, string | undefined> = { ...env }
  for (const name of githubCredentialVars) {
    delete scrubbed[name]
  }
  return scrubbed
}

/** Host git identity copied into the session global config, nothing else. */
export interface NonoGitIdentity {
  readonly userName: string | undefined
  readonly userEmail: string | undefined
}

/** Render the session global gitconfig carrying only the copied identity. */
export const buildSessionGitConfigContents = (identity: NonoGitIdentity): string => {
  const lines: Array<string> = []
  if (identity.userName !== undefined || identity.userEmail !== undefined) {
    lines.push("[user]")
    if (identity.userName !== undefined) {
      lines.push(`\tname = ${identity.userName}`)
    }
    if (identity.userEmail !== undefined) {
      lines.push(`\temail = ${identity.userEmail}`)
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`
}

/** Inputs for the sandboxed child environment. */
export interface NonoSandboxEnvInput {
  readonly sessionTmpDir: string
  readonly sessionGitConfigPath: string
}

/** Build the environment every sandboxed command runs with. */
export const buildSandboxEnv = (
  env: Record<string, string | undefined>,
  input: NonoSandboxEnvInput
): Record<string, string | undefined> => ({
  ...env,
  TMPDIR: input.sessionTmpDir,
  TMP: input.sessionTmpDir,
  TEMP: input.sessionTmpDir,
  GIT_CONFIG_GLOBAL: input.sessionGitConfigPath,
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0"
})
