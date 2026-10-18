import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { skipReason } from "@avi2dg/checks/scripts/test-skips.ts"
import { Schema } from "effect"
import { buildNonoProfile, buildNonoRunArgs, buildSandboxEnv, NonoProviderError, nonoSandboxProvider } from "../../src/nono"

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
  args: ReadonlyArray<string>
): Promise<S["Type"]> => {
  const proc = Bun.spawn(["nono", ...args], { stdout: "pipe", stderr: "pipe" })
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

const ResolvedProfile = Schema.Struct({ network: Schema.Struct({ credentials: Schema.Array(Schema.String) }) })

const manifestOf = (profilePath: string) =>
  runNono(CapabilityManifest, ["profile", "show", profilePath, "--format", "manifest"])

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

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "orc-nono-policy-")))
    resolvedRoots = { worktree: join(dir, "copy"), gitData: join(dir, "git"), piSessionDir: join(dir, "session") }
    for (const root of Object.values(resolvedRoots)) {
      await mkdir(root)
    }
    profilePath = join(dir, "profile.json")
    await writeFile(profilePath, JSON.stringify(buildNonoProfile(resolvedRoots)))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test.skipIf(Bun.which("nono") === null)(
    skipReason("needs nono on PATH to resolve the profile", "grants writes to the three roots and /dev/null and nothing more"),
    async () => {
      const { grants } = (await manifestOf(profilePath)).filesystem
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
      const { grants } = (await manifestOf(profilePath)).filesystem
      const globalConfigs = [join(homedir(), ".gitconfig"), join(homedir(), ".config", "git")]
      for (const grant of grants) {
        expect(globalConfigs.some((config) => config === grant.path || config.startsWith(`${grant.path}/`))).toBe(false)
      }
    }
  )

  test.skipIf(Bun.which("nono") === null)(
    skipReason("needs nono on PATH to resolve the profile", "routes no credential through nono's proxy"),
    async () => {
      const resolved = await runNono(ResolvedProfile, ["profile", "show", profilePath, "--json"])
      expect(resolved.network.credentials).toEqual([])
      expect((await manifestOf(profilePath)).network.mode).toBe("unrestricted")
    }
  )
})

describe("buildNonoProfile", () => {
  test("grants read-write access to exactly the three roots", () => {
    const profile = buildNonoProfile(roots)
    expect(profile.filesystem.allow).toEqual([roots.worktree, roots.gitData, roots.piSessionDir])
  })

  test("every directory grant is a root and the only file grant is writing /dev/null", () => {
    const profile = buildNonoProfile(roots)
    const directoryGrants = [
      ...profile.filesystem.allow,
      ...profile.filesystem.read,
      ...profile.filesystem.write,
      ...profile.filesystem.unix_socket_dir,
      ...profile.filesystem.unix_socket_dir_bind,
      ...profile.filesystem.unix_socket_subtree,
      ...profile.filesystem.unix_socket_subtree_bind
    ]
    const fileGrants = [
      ...profile.filesystem.allow_file,
      ...profile.filesystem.read_file,
      ...profile.filesystem.write_file,
      ...profile.filesystem.unix_socket,
      ...profile.filesystem.unix_socket_bind
    ]
    expect(directoryGrants).toEqual([roots.worktree, roots.gitData, roots.piSessionDir])
    expect(fileGrants).toEqual(["/dev/null"])
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

  test("extends the default base with an isolated security posture", () => {
    const profile = buildNonoProfile(roots)
    expect(profile.extends).toBe("default")
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
      "git status"
    ])
  })

  test("passes hostile commands through verbatim", () => {
    const command = "echo 'a; rm -rf /' && $(touch evil)"
    const argv = buildNonoRunArgs("/tmp/p.json", command)
    expect(argv[argv.length - 1]).toBe(command)
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
    const env = buildSandboxEnv(hostEnv, "/tmp/orc-test/session/tmp")
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "NONO_ALLOW"]) {
      expect(env[name]).toBeUndefined()
    }
    expect(env.PATH).toBe(hostEnv.PATH)
    expect(env.HOME).toBe(hostEnv.HOME)
  })

  test("points the temp dir at the session folder and git at empty global and system config", () => {
    const env = buildSandboxEnv(hostEnv, "/tmp/orc-test/session/tmp")
    expect(env.TMPDIR).toBe("/tmp/orc-test/session/tmp")
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null")
    expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null")
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
      expect(await gitConfigExtraHeader(buildSandboxEnv(host, join(home, "tmp")), home)).toBe("")
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
  ["an insteadOf rewrite to a URL with userinfo", [`url.https://x:${sentinelToken}@github.com/.insteadOf`, "https://github.com/"], "url.insteadof"]
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
