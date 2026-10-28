import { Effect, FileSystem } from "effect"

export interface CheckedModelWindow {
  readonly ref: string
  readonly provider: string
  readonly id: string
  readonly window: number
}

export interface NonoSandboxRoots {
  readonly worktree: string
  readonly gitData: string
  readonly piSessionDir: string
}

// nono applies these to a profile that names no base unless they are excluded; its required deny groups cannot be.
const nonoImplicitGroups: ReadonlyArray<string> = [
  "system_read_macos",
  "system_read_linux_core",
  "system_write_macos",
  "system_write_linux",
  "user_tools",
  "homebrew_macos",
  "homebrew_linux",
  "dangerous_commands",
  "dangerous_commands_macos",
  "dangerous_commands_linux"
]

const packagePrefixReads = (prefix: string): ReadonlyArray<string> =>
  ["bin", "lib", "libexec", "Cellar", "opt", "share"].map((dir) => `${prefix}/${dir}`)

// Folders of programs, libraries and certificates are read whole; no folder git or its includes read configuration from is.
export const systemReadPaths: ReadonlyArray<string> = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/usr/libexec",
  "/usr/share",
  "/lib",
  "/lib64",
  "/dev",
  "/System/Library",
  "/System/Volumes/Preboot/Cryptexes/OS",
  "/private/var/db/dyld",
  "/private/var/db/timezone",
  "/private/var/select",
  "/etc/ssl/certs"
]

const certPemPath = "/etc/ssl/cert.pem"

const certPemIsSymlink: Effect.Effect<boolean, never, FileSystem.FileSystem> = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readLink(certPemPath).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  )
})

// A link grant reaches only its target, so the link path stays denied.
export const runtimeReadFiles: Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem> = Effect.gen(function*() {
  const drop = process.platform === "darwin" && (yield* certPemIsSymlink)
  return drop
    ? ["/etc/hosts", "/etc/resolv.conf", "/etc/localtime", "/etc/ssl/openssl.cnf"]
    : ["/etc/hosts", "/etc/resolv.conf", "/etc/localtime", certPemPath, "/etc/ssl/openssl.cnf"]
})

// Apple's git shim loads the whole Xcode bundle around its developer folder and checks the licence it records.
const developerReads = (developerDir: string | null): ReadonlyArray<string> => {
  if (developerDir === null) {
    return []
  }
  return developerDir.endsWith(".app/Contents/Developer")
    ? [developerDir.slice(0, -"/Developer".length), "/Library/Preferences/com.apple.dt.Xcode.plist"]
    : [developerDir]
}

export const within = (root: string, target: string): boolean => target === root || target.startsWith(`${root}/`)

// A grant nested in another can be retargeted by a write through the outer one.
const outermost = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.filter((candidate, index) =>
    paths.indexOf(candidate) === index && !paths.some((other) => other !== candidate && within(other, candidate))
  )

export interface Runtime {
  readonly binDir: string
  readonly installDir: string | null
}

// The sandbox reads every folder whole, so none may hold configuration git or its includes read.
export interface ToolchainResolver {
  readonly folders: ReadonlyArray<string>
  readonly runtimeOf: (candidate: string, real: string) => Runtime | null
}

const parentOf = (file: string): string => file.slice(0, file.lastIndexOf("/"))

export const defaultToolchainFolders: ReadonlyArray<string> = [
  ...packagePrefixReads("/usr/local"),
  ...packagePrefixReads("/opt/homebrew"),
  "/nix"
]

const inToolchain = (file: string): boolean =>
  [...systemReadPaths, ...defaultToolchainFolders].some((granted) => within(granted, file))

// A folder found by walking up from a program may hold configuration, so only a toolchain folder or one mise version's own folder is read.
const defaultRuntimeOf = (candidate: string, real: string, home: string): Runtime | null => {
  const binDir = parentOf(candidate)
  if (inToolchain(candidate) && inToolchain(real)) {
    return { binDir, installDir: null }
  }
  const installs = `${home}/.local/share/mise/installs/`
  const parts = real.startsWith(installs) ? real.slice(installs.length).split("/") : []
  if (parts.length < 3) {
    return null
  }
  const installDir = `${installs}${parts.slice(0, 2).join("/")}`
  return within(installDir, candidate) ? { binDir, installDir } : null
}

export const defaultToolchainResolver = (home: string): ToolchainResolver => ({
  folders: defaultToolchainFolders,
  runtimeOf: (candidate, real) => defaultRuntimeOf(candidate, real, home)
})

// Each install folder is read only once a runtime the sandbox runs resolves inside it.
export const withInstallFolders = (base: ToolchainResolver, installFolders: ReadonlyArray<string>): ToolchainResolver => ({
  folders: base.folders,
  runtimeOf: (candidate, real) => {
    const found = base.runtimeOf(candidate, real)
    const installDir = installFolders.find((folder) => within(folder, candidate) && within(folder, real))
    return found ?? (installDir === undefined ? null : { binDir: parentOf(candidate), installDir })
  }
})

export interface HostRuntime {
  readonly developerDir: string | null
  readonly toolchainFolders: ReadonlyArray<string>
  readonly runtimeDirs: ReadonlyArray<string>
}

export interface ModelCredential {
  readonly provider: string
  readonly name: string
  readonly upstream: string
  readonly envVar: string
  readonly captureCommand: ReadonlyArray<string>
}

export interface HostTools {
  readonly piBinary: string
  readonly nodeBinary: string
  readonly homeDir: string
}

export const canRouteModel = (model: string): boolean => {
  const slash = model.indexOf("/")
  return (slash === -1 ? model : model.slice(0, slash)) === "opencode-go"
}

export const modelCredentialFor = (model: string, host: HostTools): ModelCredential | null => {
  const slash = model.indexOf("/")
  const provider = slash === -1 ? model : model.slice(0, slash)
  if (!canRouteModel(model)) {
    return null
  }
  return {
    provider,
    name: "opencode_go",
    upstream: "https://opencode.ai/zen/go/v1",
    envVar: "OPENCODE_GO_KEY",
    // nono spawns capture under its own sandbox-shaped env, where PI_CODING_AGENT_DIR points at the run session instead of the operator login.
    captureCommand: [
      "/bin/sh",
      "-c",
      "HOME=\"$2\" PATH=\"$(dirname \"$0\"):$PATH\" unset PI_CODING_AGENT_DIR; exec \"$1\" auth print-api-key --provider opencode-go",
      host.nodeBinary,
      host.piBinary,
      host.homeDir
    ]
  }
}

export const loginCheckCommand = (host: HostTools, preserveAgentDir = false): ReadonlyArray<string> => [
  "/bin/sh",
  "-c",
  preserveAgentDir ? "HOME=\"$2\" PATH=\"$(dirname \"$0\"):$PATH\" exec \"$1\" auth check --provider opencode-go" : "HOME=\"$2\" PATH=\"$(dirname \"$0\"):$PATH\" unset PI_CODING_AGENT_DIR; exec \"$1\" auth check --provider opencode-go",
  host.nodeBinary,
  host.piBinary,
  host.homeDir
]

export interface ProviderKey {
  readonly provider: string
  readonly apiKey: string
}

export const providerKeyOf = (credential: ModelCredential): ProviderKey => ({ provider: credential.provider, apiKey: "$" + credential.envVar })

export const piAgentModels = (key: ProviderKey, checked: ReadonlyArray<CheckedModelWindow>): string => {
  const overridesByProvider = new Map<string, Record<string, { readonly contextWindow: number }>>()
  for (const entry of checked) {
    const overrides = overridesByProvider.get(entry.provider) ?? {}
    overrides[entry.id] = { contextWindow: entry.window }
    overridesByProvider.set(entry.provider, overrides)
  }
  const providers: Record<string, { readonly apiKey?: string; readonly modelOverrides?: Record<string, { readonly contextWindow: number }> }> = {
    [key.provider]: { apiKey: key.apiKey }
  }
  for (const [provider, modelOverrides] of overridesByProvider) {
    providers[provider] = { ...providers[provider], modelOverrides }
  }
  return JSON.stringify({ providers }, null, 2) + "\n"
}

interface CredentialRoute {
  readonly upstream: string
  readonly credential_key: string
  readonly inject_header: string
  readonly credential_format: string
  readonly env_var: string
}

interface CredentialCapture {
  readonly command: ReadonlyArray<string>
  readonly timeout_secs: number
  readonly cache_ttl_secs: number
}

export type NonoProfile = Effect.Success<ReturnType<typeof buildNonoProfile>>

export type AgentNonoProfile = Omit<NonoProfile, "network"> & {
  readonly network: Omit<NonoProfile["network"], "credentials"> & {
    readonly credentials: ReadonlyArray<string>
    readonly custom_credentials: Record<string, CredentialRoute>
  }
  readonly credential_capture: Record<string, CredentialCapture>
}

export const buildAgentNonoProfile = (
  roots: NonoSandboxRoots,
  host: HostRuntime,
  credential: ModelCredential
): Effect.Effect<AgentNonoProfile, never, FileSystem.FileSystem> => Effect.gen(function*() {
  const base = yield* buildNonoProfile(roots, host)
  return {
    ...base,
    network: {
      ...base.network,
      credentials: [credential.name],
      custom_credentials: {
        [credential.name]: {
          upstream: credential.upstream,
          credential_key: "cmd://" + credential.name,
          inject_header: "Authorization",
          credential_format: "Bearer {}",
          env_var: credential.envVar
        }
      }
    },
    credential_capture: {
      [credential.name]: {
        command: [...credential.captureCommand],
        timeout_secs: 15,
        cache_ttl_secs: 900
      }
    }
  }
})
export const selectNonoProfile = (
  roots: NonoSandboxRoots,
  host: HostRuntime,
  credential: ModelCredential | undefined
): Effect.Effect<NonoProfile | AgentNonoProfile, never, FileSystem.FileSystem> =>
  credential === undefined ? buildNonoProfile(roots, host) : buildAgentNonoProfile(roots, host, credential)

const profileWithFiles = (
  roots: NonoSandboxRoots,
  host: HostRuntime,
  readFile: ReadonlyArray<string>
) => ({
  meta: {
    name: "orc-nono-agent",
    description: "orc agent sandbox: the isolated copy, its git data and Pi's session folder"
  },
  groups: {
    include: [],
    exclude: nonoImplicitGroups
  },
  security: {
    signal_mode: "isolated",
    capability_elevation: false
  },
  filesystem: {
    allow: outermost([roots.worktree, roots.gitData, roots.piSessionDir]),
    read: [...systemReadPaths, ...host.toolchainFolders, ...host.runtimeDirs],
    write: [],
    allow_file: [],
    read_file: [...readFile],
    write_file: ["/dev/null"],
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
    allow_domain: [],
    credentials: [],
    open_port: [],
    listen_port: [],
    no_proxy: [],
    upstream_bypass: []
  },
  workdir: {
    access: "none"
  },
  linux: {
    af_unix_mediation: "pathname"
  },
  // nono's unrestricted macOS network allows connect() to every Unix socket, and empty socket grants revoke none.
  unsafe_macos_seatbelt_rules: [
    "(deny network-outbound (regex #\"^/\"))",
    "(allow network-outbound (path \"/private/var/run/mDNSResponder\"))"
  ],
  platform_overrides: {
    macos: {
      filesystem: {
        read: developerReads(host.developerDir),
        // Callers name paths through these system symlinks; reading the link opens nothing behind it.
        read_file: ["/var", "/tmp", "/var/db/xcode_select_link"]
      }
    }
  }
}) as const

export const buildNonoProfile = (
  roots: NonoSandboxRoots,
  host: HostRuntime
): Effect.Effect<ReturnType<typeof profileWithFiles>, never, FileSystem.FileSystem> => Effect.gen(function*() {
  return profileWithFiles(roots, host, yield* runtimeReadFiles)
})
