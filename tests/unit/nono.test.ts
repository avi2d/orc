import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildNonoArgv,
  buildNonoProfile,
  NonoProviderError,
  nonoSandboxProvider,
  scrubGitHubCredentials
} from "../../src/nono"

const roots = {
  worktree: "/tmp/orc-test/worktree",
  gitData: "/tmp/orc-test/git-data",
  piSessionDir: "/tmp/orc-test/session"
}

describe("buildNonoProfile", () => {
  test("grants read-write access to exactly the three roots", () => {
    const profile = buildNonoProfile(roots)
    expect(profile.filesystem.allow).toEqual([roots.worktree, roots.gitData, roots.piSessionDir])
  })

  test("every filesystem grant stays inside the three roots", () => {
    const profile = buildNonoProfile(roots)
    const allowed = [roots.worktree, roots.gitData, roots.piSessionDir]
    const grants = [
      ...profile.filesystem.allow,
      ...profile.filesystem.read,
      ...profile.filesystem.write,
      ...profile.filesystem.allow_file,
      ...profile.filesystem.read_file,
      ...profile.filesystem.write_file,
      ...profile.filesystem.unix_socket,
      ...profile.filesystem.unix_socket_bind,
      ...profile.filesystem.unix_socket_dir,
      ...profile.filesystem.unix_socket_dir_bind,
      ...profile.filesystem.unix_socket_subtree,
      ...profile.filesystem.unix_socket_subtree_bind
    ]
    expect(grants).toEqual(allowed)
    for (const grant of grants) {
      expect(allowed.some((root) => grant === root || grant.startsWith(`${root}/`))).toBe(true)
    }
  })

  test("declares no deny exemption and mutes only the save prompt", () => {
    const profile = buildNonoProfile(roots)
    expect(profile.filesystem.deny).toEqual([])
    expect(profile.filesystem.bypass_protection).toEqual([])
    expect(profile.filesystem.suppress_save_prompt).toEqual(["/"])
  })

  test("blocks all network and declares no credential", () => {
    const profile = buildNonoProfile(roots)
    expect(profile.network.block).toBe(true)
    expect(profile.network.allow_domain).toEqual([])
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
    expect(profile.workdir.access).toBe("readwrite")
  })
})

describe("buildNonoArgv", () => {
  test("wraps the command in nono run with the profile", () => {
    expect(buildNonoArgv({ nonoBinary: "nono", profilePath: "/tmp/p.json", command: "git status" })).toEqual([
      "nono",
      "run",
      "--silent",
      "--profile",
      "/tmp/p.json",
      "--allow-cwd",
      "--",
      "sh",
      "-c",
      "git status"
    ])
  })

  test("respects a custom nono binary and passes hostile commands through verbatim", () => {
    const command = "echo 'a; rm -rf /' && $(touch evil)"
    const argv = buildNonoArgv({ nonoBinary: "/opt/bin/nono", profilePath: "/tmp/p.json", command })
    expect(argv[0]).toBe("/opt/bin/nono")
    expect(argv[argv.length - 1]).toBe(command)
  })
})

describe("scrubGitHubCredentials", () => {
  test("removes GitHub credential variables and keeps the rest", () => {
    const scrubbed = scrubGitHubCredentials({
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      GH_ENTERPRISE_TOKEN: "secret",
      GITHUB_ENTERPRISE_TOKEN: "secret",
      PATH: "/bin",
      HOME: "/Users/test"
    })
    expect(scrubbed).toEqual({ PATH: "/bin", HOME: "/Users/test" })
  })

  test("does not mutate its input", () => {
    const env = { GH_TOKEN: "secret", PATH: "/bin" }
    scrubGitHubCredentials(env)
    expect(env).toEqual({ GH_TOKEN: "secret", PATH: "/bin" })
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
