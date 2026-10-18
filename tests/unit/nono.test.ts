import { describe, expect, test } from "bun:test"
import { buildNonoRunArgs, buildSandboxEnv } from "../../src/nono"
import { buildNonoProfile } from "../../src/nono-profile"

const roots = {
  worktree: "/tmp/orc-test/worktree",
  gitData: "/tmp/orc-test/git-data",
  piSessionDir: "/tmp/orc-test/session"
}

const sentinelHeader = "Authorization: Basic b3JjLXNlbnRpbmVsOnNlY3JldA=="

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
})
