import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildNonoArgv, buildNonoProfile, buildSandboxEnv, NonoProviderError, nonoSandboxProvider } from "../../src/nono"

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

  test("drops the default base's system temp write groups and the global git config group", () => {
    const profile = buildNonoProfile(roots)
    expect(profile.groups.exclude).toEqual(expect.arrayContaining(["system_write_macos", "system_write_linux"]))
    expect(profile.groups.include).not.toContain("git_config")
    expect(profile.groups.include).not.toContain("system_write_macos")
    expect(profile.groups.include).not.toContain("system_write_linux")
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

  test("declares no credential", () => {
    const profile = buildNonoProfile(roots)
    expect(profile.network.credentials).toEqual([])
    const document = JSON.stringify(profile)
    for (const key of ["credential_capture", "custom_credentials", "env_credentials", "credential_providers"]) {
      expect(document).not.toContain(key)
    }
  })

  test("extends the default base with an isolated security posture", () => {
    const profile = buildNonoProfile(roots)
    expect(profile.extends).toBe("default")
    expect(profile.security.signal_mode).toBe("isolated")
    expect(profile.security.capability_elevation).toBe(false)
  })
})

describe("buildNonoArgv", () => {
  test("wraps the command in nono run with the profile and no cwd grant", () => {
    expect(buildNonoArgv("/tmp/p.json", "git status")).toEqual([
      "nono",
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
    const argv = buildNonoArgv("/tmp/p.json", command)
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

describe("nonoSandboxProvider", () => {
  test("refuses to create a sandbox when the worktree is not a git checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-nono-plain-"))
    try {
      const provider = nonoSandboxProvider({ piSessionDir: join(dir, "session") })
      const error = await provider.create({ worktreePath: dir, hostRepoPath: dir, mounts: [], env: {} }).then(
        () => null,
        (cause: unknown) => cause
      )
      expect(error).toBeInstanceOf(NonoProviderError)
      if (error instanceof NonoProviderError) {
        expect(error.reason).toContain("cannot resolve git data dir")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
