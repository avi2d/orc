import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir, userInfo } from "node:os"
import { basename, join, relative } from "node:path"
import { skipReason } from "@avi2dg/checks/scripts/test-skips.ts"
import { createSandbox } from "@ai-hero/sandcastle"
import { Schema } from "effect"
import { buildNonoRunArgs, buildSandboxEnv, NonoProviderError, nonoSandboxProvider } from "../../src/nono"
import { buildNonoProfile, runtimeReadFiles, toolchainReadPaths } from "../../src/nono-profile"

const roots = {
  worktree: "/tmp/orc-test/worktree",
  gitData: "/tmp/orc-test/git-data",
  piSessionDir: "/tmp/orc-test/session"
}

const noHost = { developerDir: null, runtimeDirs: [] }

// nono refuses a HOME whose state root falls under the /var or /tmp it grants, so the fixture home is not under the system temp dir.
const systemTempRoots = ["/tmp", "/private/tmp", "/var", "/private/var"]
const underSystemTemp = (candidate: string): boolean =>
  systemTempRoots.some((root) => candidate === root || candidate.startsWith(root + "/"))
const homeBase = (cwd: string, systemTmp: string): string =>
  !underSystemTemp(cwd) ? cwd : (!underSystemTemp(systemTmp) ? systemTmp : cwd)
const fixtureHome = await mkdtemp(join(homeBase(process.cwd(), tmpdir()), ".orc-nono-home-"))
await writeFile(join(fixtureHome, ".gitconfig"), "")
const fixtureGitEnv = { PATH: Bun.env.PATH ?? "", HOME: fixtureHome, GIT_CONFIG_GLOBAL: join(fixtureHome, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" }

afterAll(async () => {
  await rm(fixtureHome, { recursive: true, force: true })
})

const sentinelHeader = "Authorization: Basic b3JjLXNlbnRpbmVsOnNlY3JldA=="

const within = (root: string, target: string): boolean => target === root || target.startsWith(`${root}/`)

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


const createError = async (worktree: string, piSessionDir: string, env: Record<string, string> = {}): Promise<unknown> =>
  nonoSandboxProvider({ piSessionDir })
    .create({ worktreePath: worktree, hostRepoPath: worktree, mounts: [], env: { HOME: fixtureHome, ...env } })
    .then(async (handle) => {
      await handle.close()
      return null
    }, (cause: unknown) => cause)

const refusalOf = async (worktree: string, piSessionDir: string, env: Record<string, string> = {}): Promise<string> => {
  const error = await createError(worktree, piSessionDir, env)
  if (!(error instanceof NonoProviderError)) {
    throw new Error(`expected a NonoProviderError, got ${String(error)}`)
  }
  return error.message
}

const git = (args: ReadonlyArray<string>, cwd: string): void => {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: fixtureGitEnv, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  }
}

const checkoutWithSubmodule = async (dir: string): Promise<string> => {
  const dependency = join(dir, "dependency")
  const main = join(dir, "main")
  for (const repo of [dependency, main]) {
    await mkdir(repo)
    git(["init", "-q"], repo)
    git(["-c", "user.name=orc", "-c", "user.email=orc@example.com", "commit", "-q", "--allow-empty", "-m", "seed"], repo)
  }
  git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "dep"], main)
  return main
}

const extraHeaderOrigins = (cwd: string): ReadonlyArray<string> =>
  Bun.spawnSync(["git", "config", "--show-origin", "--get-all", "http.extraHeader"], { cwd, env: fixtureGitEnv, stdout: "pipe", stderr: "pipe" })
    .stdout.toString().split("\n").filter((line) => line !== "").map((line) => line.slice(0, line.indexOf("\t")))

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
    await writeFile(profilePath, JSON.stringify(buildNonoProfile(resolvedRoots, noHost)))
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
      const globalConfigs = [home, homedir()].flatMap((user) => [join(user, ".gitconfig"), join(user, ".config", "git")])
      for (const grant of grants) {
        expect(globalConfigs.filter((config) => within(grant.path, config) || within(config, grant.path))).toEqual([])
      }
    }
  )

  test.skipIf(Bun.which("nono") === null)(
    skipReason("needs nono on PATH to resolve the profile", "grants no access to the macOS Data volume, which holds every user's files under another path"),
    async () => {
      const dataVolume = "/System/Volumes/Data"
      const { grants } = (await manifestOf(profilePath, home)).filesystem
      expect(grants.filter((grant) => within(grant.path, dataVolume) || within(dataVolume, grant.path))).toEqual([])
    }
  )

  test.skipIf(Bun.which("nono") === null)(
    skipReason("needs nono on PATH to resolve the profile", "reads no configuration folder, git config or home folder outside the roots"),
    async () => {
      const configFolders = ["/etc", "/private/etc", "/usr/local/etc", "/opt/homebrew/etc", home]
      const { grants } = (await manifestOf(profilePath, home)).filesystem
      const outsideRoots = grants.filter((grant) =>
        grant.access.includes("read") && !Object.values(resolvedRoots).some((root) => within(root, grant.path))
      )
      expect(outsideRoots.filter((grant) =>
        (grant.type === "directory" && basename(grant.path) === "etc") ||
        basename(grant.path).includes("gitconfig") ||
        configFolders.some((folder) => within(grant.path, folder)) ||
        within(home, grant.path)
      )).toEqual([])
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
      const platformReadFiles = process.platform === "darwin" ? buildNonoProfile(resolvedRoots, noHost).platform_overrides.macos.filesystem.read_file : []
      const expected = new Set([
        ...toolchainReadPaths.map((path) => `read directory ${path}`),
        ...[...runtimeReadFiles, ...platformReadFiles].map((path) => `read file ${path}`),
        ...Object.values(resolvedRoots).map((root) => `readwrite directory ${root}`),
        "write file /dev/null"
      ])
      expect(new Set(grants.map((grant) => `${grant.access} ${grant.type} ${grant.path}`))).toEqual(expected)
    }
  )

})

describe("buildNonoRunArgs", () => {
  test("hands positional arguments to the shell as $1 and on, never as script text", () => {
    const hostile = "/w/copy/$(touch evil) \"quoted\""
    const argv = buildNonoRunArgs("/tmp/p.json", "printf %s \"$1\"", [hostile])
    const proc = Bun.spawnSync(argv.slice(argv.indexOf("--") + 1))
    expect(proc.stdout.toString()).toBe(hostile)
  })
})

describe("buildSandboxEnv", () => {
  test("Sandcastle's git setup writes the global config into the session folder, not the user's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-gitsetup-"))
    try {
      const home = join(dir, "home")
      const session = join(dir, "session")
      await mkdir(home)
      await mkdir(session)
      await writeFile(join(home, ".gitconfig"), "[user]\n\tname = host user\n")
      const env = buildSandboxEnv({ PATH: Bun.env.PATH, HOME: home }, session, [])
      for (const args of [
        ["config", "--global", "--add", "safe.directory", "/w/copy"],
        ["config", "--global", "user.name", "orc agent"],
        ["config", "--global", "user.email", "orc@example.com"]
      ]) {
        expect(Bun.spawnSync(["git", ...args], { cwd: dir, env }).exitCode).toBe(0)
      }
      const read = Bun.spawnSync(["git", "config", "--file", join(session, "gitconfig"), "user.name"], { env: fixtureGitEnv })
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
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: sentinelHeader
      }
      expect(await gitConfigExtraHeader(host, home)).toBe(`${sentinelHeader}\n${sentinelHeader}\n`)
      expect(await gitConfigExtraHeader(buildSandboxEnv(host, join(home, "session"), []), home)).toBe("")
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
  ["a submodule URL with userinfo", ["submodule.dep.url", `https://${sentinelToken}@github.com/orc/dep.git`], "submodule.url"],
  ["an explicit-helper remote URL with userinfo", ["remote.origin.url", `https::https://x:${sentinelToken}@github.com/orc/x.git`], "remote.url"],
  ["an explicit-helper push URL with userinfo", ["remote.origin.pushurl", `https::https://${sentinelToken}@github.com/orc/x.git`], "remote.pushurl"],
  ["an explicit-helper submodule URL with userinfo", ["submodule.dep.url", `https::https://x:${sentinelToken}@github.com/orc/dep.git`], "submodule.url"],
  ["an explicit-helper pushInsteadOf target with userinfo", [`url.https::https://x:${sentinelToken}@github.com/.pushInsteadOf`, "https://github.com/"], "url.pushinsteadof"]
]

describe("nonoSandboxProvider", () => {
  for (const [name, [key, value], reported] of credentialBearingConfigs) {
    test(`refuses a checkout whose local git config carries ${name}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "orc-nono-cred-"))
      try {
        git(["init", "-q"], dir)
        git(["config", key, value], dir)
        const reason = await refusalOf(dir, join(dir, ".session"))
        expect(reason).toContain(`carries a credential in ${reported}`)
        expect(reason).not.toContain(sentinelToken)
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
      const reason = await refusalOf(dir, join(dir, ".session"))
      expect(reason).toContain("carries a credential in http.extraheader")
      expect(reason).not.toContain(sentinelToken)
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
      const active = Bun.spawnSync(["git", "config", "--get", "http.extraHeader"], { cwd: dir, env: fixtureGitEnv })
      expect(active.exitCode).toBe(1)
      const reason = await refusalOf(dir, join(dir, ".session"))
      expect(reason).toContain(`${await realpath(join(dir, ".git", "push-auth.conf"))} carries a credential in http.extraheader`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses a checkout whose include resolves relative to the path git opened, not the include's symlink target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-cred-"))
    try {
      git(["init", "-q"], dir)
      await mkdir(join(dir, "cfg"))
      await writeFile(join(dir, "cfg", "base.inc"), "[include]\n\tpath = auth.inc\n")
      await symlink(join("cfg", "base.inc"), join(dir, "shared.inc"))
      await writeFile(join(dir, "auth.inc"), `[http]\n\textraHeader = Authorization: Bearer ${sentinelToken}\n`)
      git(["config", "include.path", "../shared.inc"], dir)
      expect(extraHeaderOrigins(dir)).toEqual(["file:.git/../auth.inc"])
      const reason = await refusalOf(dir, join(dir, ".session"))
      expect(reason).toContain(`${await realpath(dir)}/.git/../auth.inc carries a credential in http.extraheader`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(!process.cwd().startsWith(`${userInfo().homedir}/`))(
    skipReason("needs the working directory under the user's home", "refuses a checkout whose ~user/ include carries an http extraHeader", "local"),
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "orc-nono-cred-"))
      const outside = await mkdtemp(join(process.cwd(), ".orc-nono-include-"))
      try {
        git(["init", "-q"], dir)
        const included = join(outside, "auth.inc")
        await writeFile(included, `[http]\n\textraHeader = Authorization: Bearer ${sentinelToken}\n`)
        git(["config", "include.path", `~${userInfo().username}/${relative(userInfo().homedir, included)}`], dir)
        expect(extraHeaderOrigins(dir)).toEqual([`file:${included}`])
        const reason = await refusalOf(dir, join(dir, ".session"))
        expect(reason).toContain(`${included} carries a credential in http.extraheader`)
      } finally {
        await rm(dir, { recursive: true, force: true })
        await rm(outside, { recursive: true, force: true })
      }
    }
  )

  test("refuses a checkout whose inactive include recurses through a symlinked directory, as git would", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-cred-"))
    try {
      git(["init", "-q"], dir)
      await writeFile(join(dir, ".git", "self.inc"), "[include]\n\tpath = again/self.inc\n")
      await symlink(".", join(dir, ".git", "again"))
      git(["config", "includeIf.onbranch:never.path", "self.inc"], dir)
      const gitReads = Bun.spawnSync(["git", "config", "--includes", "--file", join(dir, ".git", "self.inc"), "--list"], { env: fixtureGitEnv, stdout: "pipe", stderr: "pipe" })
      expect(gitReads.stderr.toString()).toContain("exceeded maximum include depth")
      const reason = await refusalOf(dir, join(dir, ".session"))
      expect(reason).toContain("is included deeper than git reads")
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
      const reason = await refusalOf(join(dir, "linked"), join(dir, "session"))
      expect(reason).toContain(`${await realpath(join(main, ".git", "config.worktree"))} carries a credential in http.extraheader`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses a checkout whose submodule's own git config carries a credential-bearing remote URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-cred-"))
    try {
      const main = await checkoutWithSubmodule(dir)
      const submoduleGitDir = join(main, ".git", "modules", "dep")
      git(["config", "remote.origin.url", `https://${sentinelToken}@github.com/orc/dep.git`], submoduleGitDir)
      const reason = await refusalOf(main, join(dir, "session"))
      expect(reason).toContain(`${await realpath(join(submoduleGitDir, "config"))} carries a credential in remote.url`)
      expect(reason).not.toContain(sentinelToken)
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
      const reason = await refusalOf(dir, join(dir, ".session"))
      expect(reason).toContain(`${await realpath(join(nested, "worktrees", "linked", "config.worktree"))} carries a credential in http.extraheader`)
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
      const reason = await refusalOf(dir, join(dir, ".session"))
      expect(reason).toContain(`${await realpath(join(dir, ".gitmodules"))} carries a credential in submodule.url`)
      expect(reason).not.toContain(sentinelToken)
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
      const reason = await refusalOf(dir, join(dir, ".session"))
      expect(reason).toContain(`${await realpath(join(dir, "vendor", "dep", ".gitmodules"))} carries a credential in submodule.url`)
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
      const reason = await refusalOf(dir, join(dir, ".session"))
      expect(reason).toContain(`${await realpath(join(dir, "dep", ".git", "config"))} carries a credential in http.extraheader`)
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
      const reason = await refusalOf(dir, join(dir, ".session"))
      expect(reason).toContain(`cannot scan ${await realpath(join(dir, ".git", "modules"))} for credentials`)
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
        const main = await checkoutWithSubmodule(dir)
        expect(await createError(main, join(dir, "session"))).toBeNull()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  test("scans the checkout with the host's git, not a git the caller's PATH finds in the copy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-cred-"))
    try {
      git(["init", "-q"], dir)
      git(["config", "http.extraHeader", `Authorization: Bearer ${sentinelToken}`], dir)
      await mkdir(join(dir, "bin"))
      await writeFile(join(dir, "bin", "git"), `#!/bin/sh\ntouch "${join(dir, "ran-outside-nono")}"\n`, { mode: 0o755 })
      const reason = await refusalOf(dir, join(dir, ".session"), { PATH: `${join(dir, "bin")}:${Bun.env.PATH}` })
      expect(reason).toContain("carries a credential in http.extraheader")
      expect(await Bun.file(join(dir, "ran-outside-nono")).exists()).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("Sandcastle's createSandbox reports the provider's refusal reason", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-sandcastle-"))
    const saved = { HOME: Bun.env.HOME, GIT_CONFIG_GLOBAL: Bun.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: Bun.env.GIT_CONFIG_NOSYSTEM }
    Object.assign(Bun.env, { HOME: fixtureGitEnv.HOME, GIT_CONFIG_GLOBAL: fixtureGitEnv.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: "1" })
    try {
      git(["init", "-q", "-b", "main"], dir)
      await writeFile(join(dir, ".gitignore"), ".sandcastle/\n")
      git(["add", "-A"], dir)
      git(["-c", "user.name=orc", "-c", "user.email=orc@example.com", "commit", "-q", "-m", "seed"], dir)
      git(["remote", "add", "origin", `https://x-access-token:${sentinelToken}@github.com/orc/x.git`], dir)
      await mkdir(join(dir, ".sandcastle"))
      await writeFile(join(dir, ".sandcastle", ".env"), `HOME=${fixtureHome}\n`)
      const error = await createSandbox({ branch: "orc/refused", sandbox: nonoSandboxProvider({ piSessionDir: join(dir, "session") }), cwd: dir })
        .then(async (sandbox) => {
          await sandbox.close()
          return null
        }, (cause: unknown) => cause)
      expect(error).toBeInstanceOf(Error)
      if (error instanceof Error) {
        expect(error.message).toContain("Provider 'orc-nono' create failed: orc nono provider: the git config")
        expect(error.message).toContain("carries a credential in remote.url")
        expect(error.message).not.toContain(sentinelToken)
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete Bun.env[key]
        } else {
          Bun.env[key] = value
        }
      }
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses to create a sandbox when the worktree is not a git checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-plain-"))
    try {
      const reason = await refusalOf(dir, join(dir, "session"))
      expect(reason).toContain("cannot resolve git data dir")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
