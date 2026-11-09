import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { skipReason } from "@avi2dg/checks/scripts/test-skips.ts"
import type { NonoExecOptions } from "../../packages/run/src/nono-exec"
import { makeNonoFixtureDir } from "../lib/nono-home"
import { runNonoShell } from "../lib/nono-shell"

const liveSandbox = Bun.env.ORC_NONO_E2E === "1"

const vendoredCommit = "0123456789abcdef0123456789abcdef01234567\n"
const cachedCommit = join(".cache", "avi2dg-checks", "repos", "example.com", "acme", "lib", "lib@1.0.0.commit")

const project = {
  name: "acme-install-fixture",
  private: true,
  scripts: { prepare: "cat \"$HOME/" + cachedCommit + "\" > vendored.commit" },
  dependencies: { "is-number": "7.0.0" }
}

const run = async (command: ReadonlyArray<string>, cwd: string, env: Record<string, string>): Promise<void> => {
  const proc = Bun.spawn([...command], { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (exitCode !== 0) {
    throw new Error(command.join(" ") + " failed: " + stdout + stderr)
  }
}

describe("the copy's install under nono", () => {
  let root = ""
  let home = ""
  let copy = ""
  let sessions = ""

  const sandbox = (): NonoExecOptions => ({
    worktree: copy,
    piSessionDir: sessions,
    sessionsDir: sessions,
    hostEnv: { ...Bun.env, HOME: home },
    env: {}
  })

  beforeAll(async () => {
    if (!liveSandbox) {
      return
    }
    root = await mkdtemp(join(tmpdir(), "orc-nono-install-"))
    home = await makeNonoFixtureDir("orc-nono-install-home-")
    await mkdir(join(home, ".cache", "avi2dg-checks", "repos", "example.com", "acme", "lib"), { recursive: true })
    await writeFile(join(home, cachedCommit), vendoredCommit)
    await mkdir(join(home, ".ssh"))
    await writeFile(join(home, ".ssh", "id_ed25519"), "not a key\n")
    await writeFile(join(home, ".zshrc"), "export ACME=1\n")
    await writeFile(join(home, ".gitconfig"), "")
    const projectDir = join(root, "project")
    copy = join(root, "copy")
    sessions = join(root, "sessions")
    await mkdir(projectDir)
    await writeFile(join(projectDir, "package.json"), JSON.stringify(project, null, 2) + "\n")
    await writeFile(join(projectDir, "bunfig.toml"), "")
    await writeFile(join(projectDir, ".gitignore"), "node_modules\nvendored.commit\n")
    const lockHome = join(root, "lock-home")
    await mkdir(lockHome)
    await run(["bun", "install", "--lockfile-only", "--ignore-scripts"], projectDir, { PATH: Bun.env.PATH ?? "", HOME: lockHome, BUN_INSTALL_CACHE_DIR: join(lockHome, "cache") })
    const gitEnv = { PATH: Bun.env.PATH ?? "", HOME: home, GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" }
    await run(["git", "init", "-q"], projectDir, gitEnv)
    await run(["git", "add", "-A"], projectDir, gitEnv)
    await run(["git", "-c", "user.name=orc live", "-c", "user.email=orc-live@example.com", "commit", "-qm", "seed"], projectDir, gitEnv)
    await run(["git", "worktree", "add", "-q", "-b", "orc/install", copy], projectDir, gitEnv)
  })

  afterAll(async () => {
    for (const dir of [root, home]) {
      if (dir !== "") {
        await rm(dir, { recursive: true, force: true })
      }
    }
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "runs a cold frozen install whose prepare reads the checks cache"), async () => {
    const result = await runNonoShell(sandbox(), "bun install --frozen-lockfile 2>&1; echo exit=$?")
    expect(result.stdout).toEndWith("exit=0\n")
    expect(await Bun.file(join(copy, "vendored.commit")).text()).toBe(vendoredCommit)
    expect(await Bun.file(join(copy, "node_modules", "is-number", "package.json")).json()).toMatchObject({ name: "is-number", version: "7.0.0" })
  }, 120_000)

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "keeps the checks cache read-only and the rest of HOME unreadable"), async () => {
    const result = await runNonoShell(sandbox(), [
      `cat "$HOME/${cachedCommit}" >/dev/null && echo cache-read`,
      `touch "$HOME/.cache/avi2dg-checks/orc-probe-write" 2>/dev/null && echo cache-written || echo cache-write-refused`,
      `head -c1 "$HOME/.zshrc" >/dev/null 2>&1 && echo zshrc-read || echo zshrc-refused`,
      `ls "$HOME/.ssh" >/dev/null 2>&1 && echo ssh-listed || echo ssh-refused`,
      `ls "$HOME/.cache" >/dev/null 2>&1 && echo cache-parent-listed || echo cache-parent-refused`
    ].join("; "))
    expect(result.stdout).toBe("cache-read\ncache-write-refused\nzshrc-refused\nssh-refused\ncache-parent-refused\n")
  }, 60_000)
})
