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
export const toolchainReadPaths: ReadonlyArray<string> = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/usr/libexec",
  "/usr/share",
  ...packagePrefixReads("/usr/local"),
  ...packagePrefixReads("/opt/homebrew"),
  "/lib",
  "/lib64",
  "/dev",
  "/nix",
  "/System/Library",
  "/System/Volumes/Preboot/Cryptexes/OS",
  "/private/var/db/dyld",
  "/private/var/db/timezone",
  "/private/var/select",
  "/etc/ssl/certs"
]

export const runtimeReadFiles: ReadonlyArray<string> = [
  "/etc/hosts",
  "/etc/resolv.conf",
  "/etc/localtime",
  "/etc/ssl/cert.pem",
  "/etc/ssl/openssl.cnf"
]

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

const parentOf = (file: string): string => file.slice(0, file.lastIndexOf("/"))

const inToolchain = (file: string): boolean => toolchainReadPaths.some((granted) => within(granted, file))

// A folder found by walking up from a program may hold configuration, so only a toolchain folder or one mise version's own folder is read.
export const runtimeOf = (candidate: string, real: string, home: string): Runtime | null => {
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

export interface HostRuntime {
  readonly developerDir: string | null
  readonly runtimeDirs: ReadonlyArray<string>
}

export const buildNonoProfile = (roots: NonoSandboxRoots, host: HostRuntime) => ({
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
    read: [...toolchainReadPaths, ...host.runtimeDirs],
    write: [],
    allow_file: [],
    read_file: runtimeReadFiles,
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
