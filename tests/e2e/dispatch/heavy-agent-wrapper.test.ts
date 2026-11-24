import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { writeHeavyBin } from "../../../packages/run/src/entities/heavy-queue/heavy-setup"

test.each(["claude", "codex", "opencode", "pi"])("%s uses the daemon's first agent instead of the setup process's agent", async (agent) => {
  const root = await mkdtemp(join(tmpdir(), "orc-agent-path-"))
  const home = join(root, "home")
  const setupBin = join(root, "setup")
  const daemonBin = join(root, "daemon")
  const laterBin = join(root, "later")
  const aliases = join(root, "aliases")
  const wrapper = join(home, "heavy", "agents", agent)
  const originalPath = process.env.PATH
  try {
    await Promise.all([setupBin, daemonBin, laterBin, aliases].map((dir) => mkdir(dir)))
    await writeFile(join(setupBin, agent), "#!/bin/sh\nprintf 'setup\\n'\n", { mode: 0o755 })
    await writeFile(join(laterBin, agent), "#!/bin/sh\nprintf 'later\\n'\n", { mode: 0o755 })
    await writeFile(join(daemonBin, agent), "#!/bin/sh\nprintf '%s\\n' daemon \"$HEAVY_TESTS_CI_ONLY\" \"$PATH\" \"$@\"\nexit 23\n", { mode: 0o755 })
    process.env.PATH = setupBin + ":/usr/bin:/bin"
    await Effect.runPromise(writeHeavyBin(home, { group: "heavy", commands: [], limit: "none", through: ["env"] }, "linux").pipe(Effect.provide(BunServices.layer)))
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
    await symlink(wrapper, join(aliases, agent))
    const callerPath = join(home, "heavy", "agents") + ":" + aliases + ":" + daemonBin + ":" + laterBin + ":/usr/bin:/bin"
    const child = Bun.spawnSync([wrapper, "two words", "", "--version"], {
      env: { PATH: callerPath, HEAVY_TESTS_CI_ONLY: "0" },
      stdout: "pipe",
      stderr: "pipe"
    })
    expect(child.exitCode).toBe(23)
    expect(child.stderr.toString()).toBe("")
    expect(child.stdout.toString().split("\n")).toEqual([
      "daemon", "1", join(home, "heavy", "ci-only") + ":" + join(home, "heavy", "bin") + ":" + callerPath,
      "two words", "", "--version", ""
    ])
    const missing = Bun.spawnSync([wrapper], {
      env: { PATH: join(home, "heavy", "agents") + ":" + aliases },
      stdout: "pipe",
      stderr: "pipe"
    })
    expect(missing.exitCode).toBe(127)
    expect(missing.stdout.toString()).toBe("")
    expect(missing.stderr.toString()).toBe("orc heavy: no " + agent + " on PATH other than this wrapper\n")
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
    await rm(root, { recursive: true, force: true })
  }
})
