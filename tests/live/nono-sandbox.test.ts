import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { skipReason } from "@avi2dg/checks/scripts/test-skips.ts"
import type { BindMountSandboxHandle } from "@ai-hero/sandcastle"
import { nonoSandboxProvider, type NonoSandboxProvider } from "../../src/nono"

/**
 * Real sandbox proofs. These nest a nono sandbox, which macOS forbids
 * inside an already-sandboxed session, so they run only on demand in the
 * live tier, outside any sandbox:
 *
 *   ORC_NONO_E2E=1 bun run test:live
 */
const liveSandbox = Bun.env.ORC_NONO_E2E === "1"

const runGit = async (args: ReadonlyArray<string>, cwd: string): Promise<void> => {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stdout}${stderr}`)
  }
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe("nono sandbox provider", () => {
  let root = ""
  let copy = ""
  let outside = ""
  let session = ""
  let provider: NonoSandboxProvider | null = null
  let handle: BindMountSandboxHandle | null = null

  const execOrThrow = async (...args: Parameters<BindMountSandboxHandle["exec"]>) => {
    if (handle === null) {
      throw new Error("sandbox handle was not created")
    }
    return handle.exec(...args)
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "orc-nono-live-"))
    copy = join(root, "copy")
    outside = join(root, "outside")
    session = join(root, "session")
    await mkdir(copy, { recursive: true })
    await mkdir(outside, { recursive: true })
    await mkdir(session, { recursive: true })
    await runGit(["init", "-q"], copy)
    await runGit(["config", "user.email", "orc-live@example.com"], copy)
    await runGit(["config", "user.name", "orc live"], copy)
    await writeFile(join(copy, "seed.txt"), "seed\n")
    await runGit(["add", "-A"], copy)
    await runGit(["commit", "-qm", "seed"], copy)
    await runGit(["remote", "add", "origin", "https://github.com/orc-live/does-not-exist.git"], copy)
    provider = nonoSandboxProvider({ piSessionDir: session })
    handle = await provider.create({
      worktreePath: copy,
      hostRepoPath: copy,
      mounts: [],
      env: { GH_TOKEN: "live-fake-token", GITHUB_TOKEN: "live-fake-token" }
    })
  })

  afterAll(async () => {
    await handle?.close()
    if (root !== "") {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(!liveSandbox)(
    skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "writes inside the isolated copy"),
    async () => {
      const result = await execOrThrow("touch probe-inside && echo wrote-ok")
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("wrote-ok")
      expect(await exists(join(copy, "probe-inside"))).toBe(true)
    }
  )

  test.skipIf(!liveSandbox)(
    skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "streams stdout lines to onLine"),
    async () => {
      const seen: Array<string> = []
      const result = await execOrThrow("printf 'one\\ntwo\\n'", { onLine: (line) => seen.push(line) })
      expect(result.exitCode).toBe(0)
      expect(seen).toEqual(["one", "two"])
    }
  )

  test.skipIf(!liveSandbox)(
    skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "writes inside the git data and the Pi session folder"),
    async () => {
      const committed = await execOrThrow("git add probe-inside && git commit -qm live-proof && echo committed")
      expect(committed.exitCode).toBe(0)
      expect(committed.stdout).toContain("committed")
      const sessionWrite = await execOrThrow(`touch ${session}/probe && echo session-ok`)
      expect(sessionWrite.exitCode).toBe(0)
      expect(sessionWrite.stdout).toContain("session-ok")
      expect(await exists(join(session, "probe"))).toBe(true)
    }
  )

  test.skipIf(!liveSandbox)(
    skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "pipes stdin to the command"),
    async () => {
      const result = await execOrThrow("cat", { stdin: "hello-stdin" })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("hello-stdin")
    }
  )

  test.skipIf(!liveSandbox)(
    skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "refuses a write outside the copy"),
    async () => {
      const target = join(outside, "must-not-exist")
      const result = await execOrThrow(`touch ${target} && echo escaped`)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain("escaped")
      expect(await exists(target)).toBe(false)
    }
  )

  test.skipIf(!liveSandbox)(
    skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "refuses git push with no GitHub credential"),
    async () => {
      const result = await execOrThrow("git push origin HEAD:refs/heads/orc-live-probe")
      expect(result.exitCode).not.toBe(0)
    }
  )
})
