import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { skipReason } from "@avi2dg/checks/scripts/test-skips.ts"
import { Schema } from "effect"
import { buildNonoRunArgs, buildSandboxEnv, NonoProviderError, nonoSandboxProvider } from "../../src/nono"
import { buildNonoProfile, toolchainReadPaths } from "../../src/nono-profile"

const roots = {
  worktree: "/tmp/orc-test/worktree",
  gitData: "/tmp/orc-test/git-data",
  piSessionDir: "/tmp/orc-test/session"
}

const sentinelHeader = "Authorization: Basic b3JjLXNlbnRpbmVsOnNlY3JldA=="

const gitConfigExtraHeader = async (env: Record<string, string>, cwd: string): Promise<string> => {
  const proc = Bun.spawn(["git", "config", "--get-all", "http.extraHeader"], { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return stdout
}

const runNono = async <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  args: ReadonlyArray<string>,
  home: string
): Promise<S["Type"]> => {
  const proc = Bun.spawn(["nono", ...args], { env: { PATH: Bun.env.PATH, HOME: home }, stdout: "pipe", stderr: "pipe" })
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  expect(exitCode).toBe(0)
  return Schema.decodeUnknownSync(schema)(JSON.parse(stdout))
}

const CapabilityManifest = Schema.Struct({
  filesystem: Schema.Struct({
    grants: Schema.Array(Schema.Struct({ access: Schema.String, path: Schema.String, type: Schema.String }))
  }),
  network: Schema.Struct({ mode: Schema.String })
})

const ResolvedProfile = Schema.Struct({
  network: Schema.Struct({ credentials: Schema.Array(Schema.String) }),
  linux: Schema.Struct({ af_unix_mediation: Schema.String }),
  filesystem: Schema.Struct({
    unix_socket: Schema.Array(Schema.String),
    unix_socket_bind: Schema.Array(Schema.String),
    unix_socket_dir: Schema.Array(Schema.String),
    unix_socket_dir_bind: Schema.Array(Schema.String),
    unix_socket_subtree: Schema.Array(Schema.String),
    unix_socket_subtree_bind: Schema.Array(Schema.String)
  })
})

const manifestOf = (profilePath: string, home: string) =>
  runNono(CapabilityManifest, ["profile", "show", profilePath, "--format", "manifest"], home)


const createError = async (worktree: string, piSessionDir: string): Promise<unknown> =>
  nonoSandboxProvider({ piSessionDir })
    .create({ worktreePath: worktree, hostRepoPath: worktree, mounts: [], env: {} })
    .then(async (handle) => {
      await handle.close()
      return null
    }, (cause: unknown) => cause)

const git = (args: ReadonlyArray<string>, cwd: string): void => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  }
}

describe("the policy nono resolves from the profile", () => {
  let dir = ""
  let resolvedRoots = roots
  let profilePath = ""
  let home = ""
  let widened = ""

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "orc-nono-policy-")))
    resolvedRoots = { worktree: join(dir, "copy"), gitData: join(dir, "git"), piSessionDir: join(dir, "session") }
    home = join(dir, "home")
    widened = join(dir, "widened")
    for (const created of [...Object.values(resolvedRoots), widened, join(home, ".config", "nono", "profiles")]) {
      await mkdir(created, { recursive: true })
    }
    await writeFile(
      join(home, ".config", "nono", "profiles", "default.json"),
      JSON.stringify({
        meta: { name: "default", description: "a user default that widens every profile built on it" },
        groups: { include: ["system_write_macos", "system_write_linux"] },
        filesystem: { allow: [widened] },
        network: { credentials: ["github"] }
      })
    )
    profilePath = join(dir, "profile.json")
    await writeFile(profilePath, JSON.stringify(buildNonoProfile(resolvedRoots)))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test.skipIf(Bun.which("nono") === null)(
    skipReason("needs nono on PATH to resolve the profile", "grants writes to the three roots and /dev/null and nothing more"),
    async () => {
      const { grants } = (await manifestOf(profilePath, home)).filesystem
      const writable = grants.filter((grant) => grant.access.includes("write")).map((grant) => `${grant.type} ${grant.path}`)
      expect(writable.toSorted((a, b) => a.localeCompare(b))).toEqual([
        `directory ${resolvedRoots.gitData}`,
        `directory ${resolvedRoots.piSessionDir}`,
        `directory ${resolvedRoots.worktree}`,
        "file /dev/null"
      ].toSorted((a, b) => a.localeCompare(b)))
    }
  )

  test.skipIf(Bun.which("nono") === null)(
    skipReason("needs nono on PATH to resolve the profile", "grants no access to the user's global git config"),
    async () => {
      const { grants } = (await manifestOf(profilePath, home)).filesystem
      const globalConfigs = [join(homedir(), ".gitconfig"), join(homedir(), ".config", "git")]
      for (const grant of grants) {
        expect(globalConfigs.some((config) => config === grant.path || config.startsWith(`${grant.path}/`))).toBe(false)
      }
    }
  )

  test.skipIf(Bun.which("nono") === null)(
    skipReason("needs nono on PATH to resolve the profile", "routes no credential through nono's proxy"),
    async () => {
      const resolved = await runNono(ResolvedProfile, ["profile", "show", profilePath, "--json"], home)
      expect(resolved.network.credentials).toEqual([])
      expect((await manifestOf(profilePath, home)).network.mode).toBe("unrestricted")
    }
  )

  test.skipIf(Bun.which("nono") === null)(
    skipReason("needs nono on PATH to resolve the profile", "mediates Linux pathname Unix sockets with no socket granted"),
    async () => {
      const resolved = await runNono(ResolvedProfile, ["profile", "show", profilePath, "--json"], home)
      expect(resolved.linux.af_unix_mediation).toBe("pathname")
      expect(Object.values(resolved.filesystem).flat()).toEqual([])
    }
  )

  test.skipIf(Bun.which("nono") === null)(
    skipReason("needs nono on PATH to resolve the profile", "resolves to exactly the grants the profile names, whatever the user's default profile says"),
    async () => {
      const { grants } = (await manifestOf(profilePath, home)).filesystem
      const platformReadFiles = process.platform === "darwin" ? buildNonoProfile(resolvedRoots).platform_overrides.macos.filesystem.read_file : []
      const expected = new Set([
        ...toolchainReadPaths.map((path) => `read directory ${path.startsWith("~/") ? join(home, path.slice(2)) : path}`),
        ...platformReadFiles.map((path) => `read file ${path}`),
        ...Object.values(resolvedRoots).map((root) => `readwrite directory ${root}`),
        "write file /dev/null"
      ])
      expect(new Set(grants.map((grant) => `${grant.access} ${grant.type} ${grant.path}`))).toEqual(expected)
    }
  )
})

describe("buildNonoProfile", () => {
  test("grants read-write access to exactly the three roots", () => {
    const profile = buildNonoProfile(roots)
    expect(profile.filesystem.allow).toEqual([roots.worktree, roots.gitData, roots.piSessionDir])
  })

  test("drops a root nested in another, so no grant can be retargeted through a writable one", () => {
    const nested = { worktree: "/w/copy", gitData: "/w/copy/.git", piSessionDir: "/w/copy/.pi/session" }
    expect(buildNonoProfile(nested).filesystem.allow).toEqual(["/w/copy"])
    expect(buildNonoProfile({ ...nested, piSessionDir: "/w/copy-session" }).filesystem.allow).toEqual(["/w/copy", "/w/copy-session"])
  })

  test("the only writable grants are the roots and /dev/null, and no socket is granted", () => {
    const { filesystem } = buildNonoProfile(roots)
    expect([...filesystem.allow, ...filesystem.write]).toEqual([roots.worktree, roots.gitData, roots.piSessionDir])
    expect([...filesystem.allow_file, ...filesystem.write_file]).toEqual(["/dev/null"])
    const sockets = [
      ...filesystem.unix_socket,
      ...filesystem.unix_socket_bind,
      ...filesystem.unix_socket_dir,
      ...filesystem.unix_socket_dir_bind,
      ...filesystem.unix_socket_subtree,
      ...filesystem.unix_socket_subtree_bind
    ]
    expect(sockets).toEqual([])
  })

  test("the working directory adds no grant", () => {
    expect(buildNonoProfile(roots).workdir.access).toBe("none")
  })

  test("declares no deny exemption and mutes only the save prompt", () => {
    const profile = buildNonoProfile(roots)
    expect(profile.filesystem.deny).toEqual([])
    expect(profile.filesystem.bypass_protection).toEqual([])
    expect(profile.filesystem.suppress_save_prompt).toEqual(["/"])
  })

  test("keeps an isolated security posture", () => {
    const profile = buildNonoProfile(roots)
    expect(profile.security.signal_mode).toBe("isolated")
    expect(profile.security.capability_elevation).toBe(false)
  })
})

describe("buildNonoRunArgs", () => {
  test("wraps the command in nono run with the profile and no cwd grant", () => {
    expect(buildNonoRunArgs("/tmp/p.json", "git status")).toEqual([
      "run",
      "--silent",
      "--profile",
      "/tmp/p.json",
      "--",
      "sh",
      "-c",
      "git status",
      "sh"
    ])
  })

  test("passes hostile commands through verbatim", () => {
    const command = "echo 'a; rm -rf /' && $(touch evil)"
    const argv = buildNonoRunArgs("/tmp/p.json", command)
    expect(argv[argv.indexOf("-c") + 1]).toBe(command)
  })

  test("hands positional arguments to the shell as $1 and on, never as script text", () => {
    const hostile = "/w/copy/$(touch evil) \"quoted\""
    const argv = buildNonoRunArgs("/tmp/p.json", "printf %s \"$1\"", [hostile])
    const proc = Bun.spawnSync(argv.slice(argv.indexOf("--") + 1))
    expect(proc.stdout.toString()).toBe(hostile)
  })
})

describe("buildSandboxEnv", () => {
  const hostEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/test",
    GH_TOKEN: "orc-sentinel-gh",
    GITHUB_TOKEN: "orc-sentinel-github",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
    GIT_CONFIG_VALUE_0: sentinelHeader,
    NONO_ALLOW: "/",
    TMPDIR: "/var/folders/host/T/"
  }

  test("passes no credential-bearing or nono-override variable through", () => {
    const env = buildSandboxEnv(hostEnv, "/tmp/orc-test/session")
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "NONO_ALLOW"]) {
      expect(env[name]).toBeUndefined()
    }
    expect(env.PATH).toBe(hostEnv.PATH)
    expect(env.HOME).toBe(hostEnv.HOME)
  })

  test("points the temp dir and the global git config into the session folder and drops the system git config", () => {
    const env = buildSandboxEnv(hostEnv, "/tmp/orc-test/session")
    expect(env.TMPDIR).toBe("/tmp/orc-test/session/tmp")
    expect(env.GIT_CONFIG_GLOBAL).toBe("/tmp/orc-test/session/gitconfig")
    expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null")
  })

  test("Sandcastle's git setup writes the global config into the session folder, not the user's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-gitsetup-"))
    try {
      const home = join(dir, "home")
      const session = join(dir, "session")
      await mkdir(home)
      await mkdir(session)
      await writeFile(join(home, ".gitconfig"), "[user]\n\tname = host user\n")
      const env = buildSandboxEnv({ PATH: Bun.env.PATH, HOME: home }, session)
      for (const args of [
        ["config", "--global", "--add", "safe.directory", "/w/copy"],
        ["config", "--global", "user.name", "orc agent"],
        ["config", "--global", "user.email", "orc@example.com"]
      ]) {
        expect(Bun.spawnSync(["git", ...args], { cwd: dir, env }).exitCode).toBe(0)
      }
      const read = Bun.spawnSync(["git", "config", "--file", join(session, "gitconfig"), "user.name"])
      expect(read.stdout.toString()).toBe("orc agent\n")
      expect(await Bun.file(join(home, ".gitconfig")).text()).toBe("[user]\n\tname = host user\n")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("git sees no http.extraHeader from GIT_CONFIG_COUNT or the user's global config", async () => {
    const home = await mkdtemp(join(tmpdir(), "orc-nono-home-"))
    try {
      await writeFile(join(home, ".gitconfig"), `[http]\n\textraHeader = ${sentinelHeader}\n`)
      const host = {
        PATH: Bun.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: sentinelHeader
      }
      expect(await gitConfigExtraHeader(host, home)).toBe(`${sentinelHeader}\n${sentinelHeader}\n`)
      expect(await gitConfigExtraHeader(buildSandboxEnv(host, join(home, "session")), home)).toBe("")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

const sentinelToken = "orc-sentinel-token-1f2e3d"

const credentialBearingConfigs: ReadonlyArray<readonly [string, ReadonlyArray<string>, string]> = [
  ["an http extraHeader", ["http.https://github.com/.extraHeader", `Authorization: Bearer ${sentinelToken}`], "http.extraheader"],
  ["a credential helper", ["credential.helper", `!echo password=${sentinelToken}`], "credential.helper"],
  ["a remote URL with userinfo", ["remote.origin.url", `https://${sentinelToken}@github.com/orc/x.git`], "remote.url"],
  ["a push URL with userinfo", ["remote.origin.pushurl", `https://x:${sentinelToken}@github.com/orc/x.git`], "remote.pushurl"],
  ["an insteadOf rewrite to a URL with userinfo", [`url.https://x:${sentinelToken}@github.com/.insteadOf`, "https://github.com/"], "url.insteadof"],
  ["a submodule URL with userinfo", ["submodule.dep.url", `https://${sentinelToken}@github.com/orc/dep.git`], "submodule.url"]
]

describe("nonoSandboxProvider", () => {
  for (const [name, [key, value], reported] of credentialBearingConfigs) {
    test(`refuses a checkout whose local git config carries ${name}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "orc-nono-cred-"))
      try {
        git(["init", "-q"], dir)
        git(["config", key, value], dir)
        const error = await createError(dir, join(dir, ".session"))
        expect(error).toBeInstanceOf(NonoProviderError)
        if (error instanceof NonoProviderError) {
          expect(error.reason).toContain(`carries a credential in ${reported}`)
          expect(error.reason).not.toContain(sentinelToken)
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  }

  test("refuses a checkout whose included git config carries an http extraHeader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-cred-"))
    try {
      git(["init", "-q"], dir)
      await writeFile(join(dir, "included.gitconfig"), `[http]\n\textraHeader = Authorization: Bearer ${sentinelToken}\n`)
      git(["config", "include.path", join(dir, "included.gitconfig")], dir)
      const error = await createError(dir, join(dir, ".session"))
      expect(error).toBeInstanceOf(NonoProviderError)
      if (error instanceof NonoProviderError) {
        expect(error.reason).toContain("carries a credential in http.extraheader")
        expect(error.reason).not.toContain(sentinelToken)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses a checkout whose inactive conditional include carries an http extraHeader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-cred-"))
    try {
      git(["init", "-q", "-b", "orc/task"], dir)
      await writeFile(join(dir, ".git", "push-auth.conf"), `[http]\n\textraHeader = Authorization: Bearer ${sentinelToken}\n`)
      git(["config", "includeIf.onbranch:main.path", "push-auth.conf"], dir)
      const active = Bun.spawnSync(["git", "config", "--get", "http.extraHeader"], { cwd: dir })
      expect(active.exitCode).toBe(1)
      const error = await createError(dir, join(dir, ".session"))
      expect(error).toBeInstanceOf(NonoProviderError)
      if (error instanceof NonoProviderError) {
        expect(error.reason).toContain(`${await realpath(join(dir, ".git", "push-auth.conf"))} carries a credential in http.extraheader`)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses a linked worktree whose common git data holds another worktree's credential-bearing config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-cred-"))
    try {
      const main = join(dir, "main")
      await mkdir(main)
      git(["init", "-q"], main)
      git(["-c", "user.name=orc", "-c", "user.email=orc@example.com", "commit", "-q", "--allow-empty", "-m", "seed"], main)
      git(["config", "extensions.worktreeConfig", "true"], main)
      git(["config", "--worktree", "http.extraHeader", `Authorization: Bearer ${sentinelToken}`], main)
      git(["worktree", "add", "-q", join(dir, "linked")], main)
      const error = await createError(join(dir, "linked"), join(dir, "session"))
      expect(error).toBeInstanceOf(NonoProviderError)
      if (error instanceof NonoProviderError) {
        expect(error.reason).toContain(`${await realpath(join(main, ".git", "config.worktree"))} carries a credential in http.extraheader`)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses a checkout whose submodule's own git config carries a credential-bearing remote URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-cred-"))
    try {
      const dependency = join(dir, "dependency")
      const main = join(dir, "main")
      await mkdir(dependency)
      await mkdir(main)
      for (const repo of [dependency, main]) {
        git(["init", "-q"], repo)
        git(["-c", "user.name=orc", "-c", "user.email=orc@example.com", "commit", "-q", "--allow-empty", "-m", "seed"], repo)
      }
      git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "dep"], main)
      const submoduleGitDir = join(main, ".git", "modules", "dep")
      git(["config", "remote.origin.url", `https://${sentinelToken}@github.com/orc/dep.git`], submoduleGitDir)
      const error = await createError(main, join(dir, "session"))
      expect(error).toBeInstanceOf(NonoProviderError)
      if (error instanceof NonoProviderError) {
        expect(error.reason).toContain(`${await realpath(join(submoduleGitDir, "config"))} carries a credential in remote.url`)
        expect(error.reason).not.toContain(sentinelToken)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses a checkout whose nested submodule's linked worktree config carries an http extraHeader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-cred-"))
    try {
      git(["init", "-q"], dir)
      const nested = join(dir, ".git", "modules", "outer", "modules", "inner")
      git(["init", "-q", "--bare", nested], dir)
      await mkdir(join(nested, "worktrees", "linked"), { recursive: true })
      await writeFile(join(nested, "worktrees", "linked", "HEAD"), "ref: refs/heads/main\n")
      await writeFile(
        join(nested, "worktrees", "linked", "config.worktree"),
        `[http]\n\textraHeader = Authorization: Bearer ${sentinelToken}\n`
      )
      const error = await createError(dir, join(dir, ".session"))
      expect(error).toBeInstanceOf(NonoProviderError)
      if (error instanceof NonoProviderError) {
        expect(error.reason).toContain(`${await realpath(join(nested, "worktrees", "linked", "config.worktree"))} carries a credential in http.extraheader`)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses a fresh clone whose .gitmodules carries a credential-bearing submodule URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-cred-"))
    try {
      git(["init", "-q"], dir)
      git(["config", "--file", ".gitmodules", "submodule.dep.path", "dep"], dir)
      git(["config", "--file", ".gitmodules", "submodule.dep.url", `https://${sentinelToken}@github.com/orc/dep.git`], dir)
      const error = await createError(dir, join(dir, ".session"))
      expect(error).toBeInstanceOf(NonoProviderError)
      if (error instanceof NonoProviderError) {
        expect(error.reason).toContain(`${await realpath(join(dir, ".gitmodules"))} carries a credential in submodule.url`)
        expect(error.reason).not.toContain(sentinelToken)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses a checkout whose checked-out submodule's own .gitmodules carries a credential-bearing URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-cred-"))
    try {
      git(["init", "-q"], dir)
      git(["config", "--file", ".gitmodules", "submodule.dep.path", "vendor/dep"], dir)
      git(["config", "--file", ".gitmodules", "submodule.dep.url", "https://github.com/orc/dep.git"], dir)
      await mkdir(join(dir, "vendor", "dep"), { recursive: true })
      git(["config", "--file", ".gitmodules", "submodule.inner.path", "inner"], join(dir, "vendor", "dep"))
      git(["config", "--file", ".gitmodules", "submodule.inner.url", `https://x:${sentinelToken}@github.com/orc/inner.git`], join(dir, "vendor", "dep"))
      const error = await createError(dir, join(dir, ".session"))
      expect(error).toBeInstanceOf(NonoProviderError)
      if (error instanceof NonoProviderError) {
        expect(error.reason).toContain(`${await realpath(join(dir, "vendor", "dep", ".gitmodules"))} carries a credential in submodule.url`)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses a checkout whose embedded submodule git dir carries an http extraHeader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-cred-"))
    try {
      git(["init", "-q"], dir)
      git(["config", "--file", ".gitmodules", "submodule.dep.path", "dep"], dir)
      git(["config", "--file", ".gitmodules", "submodule.dep.url", "https://github.com/orc/dep.git"], dir)
      await mkdir(join(dir, "dep"))
      git(["init", "-q"], join(dir, "dep"))
      git(["config", "http.extraHeader", `Authorization: Bearer ${sentinelToken}`], join(dir, "dep"))
      const error = await createError(dir, join(dir, ".session"))
      expect(error).toBeInstanceOf(NonoProviderError)
      if (error instanceof NonoProviderError) {
        expect(error.reason).toContain(`${await realpath(join(dir, "dep", ".git", "config"))} carries a credential in http.extraheader`)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses a checkout whose git data cannot be fully scanned, rather than skipping what it could not read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-cred-"))
    const locked = join(dir, ".git", "modules", "other", "objects")
    try {
      git(["init", "-q"], dir)
      git(["init", "-q", "--bare", join(dir, ".git", "modules", "dep")], dir)
      git(["config", "http.extraHeader", `Authorization: Bearer ${sentinelToken}`], join(dir, ".git", "modules", "dep"))
      await mkdir(locked, { recursive: true })
      await chmod(locked, 0o000)
      const error = await createError(dir, join(dir, ".session"))
      expect(error).toBeInstanceOf(NonoProviderError)
      if (error instanceof NonoProviderError) {
        expect(error.reason).toContain(`cannot scan ${await realpath(join(dir, ".git", "modules"))} for credentials`)
      }
    } finally {
      await chmod(locked, 0o755)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(Bun.which("nono") === null)(
    skipReason("needs nono on PATH to create a sandbox", "accepts a checkout whose submodules carry no credential"),
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "orc-nono-clean-"))
      try {
        const dependency = join(dir, "dependency")
        const main = join(dir, "main")
        await mkdir(dependency)
        await mkdir(main)
        for (const repo of [dependency, main]) {
          git(["init", "-q"], repo)
          git(["-c", "user.name=orc", "-c", "user.email=orc@example.com", "commit", "-q", "--allow-empty", "-m", "seed"], repo)
        }
        git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "dep"], main)
        expect(await createError(main, join(dir, "session"))).toBeNull()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  test("refuses to create a sandbox when the worktree is not a git checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-plain-"))
    try {
      const error = await createError(dir, join(dir, "session"))
      expect(error).toBeInstanceOf(NonoProviderError)
      if (error instanceof NonoProviderError) {
        expect(error.reason).toContain("cannot resolve git data dir")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
