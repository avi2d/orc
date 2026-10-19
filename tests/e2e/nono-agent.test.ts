import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { skipReason } from "@avi2dg/checks/scripts/test-skips.ts"
import { NonoProviderError, nonoSandboxProvider } from "../../src/nono"
import { modelCredentialFor } from "../../src/nono-profile"

const fixtureHome = await mkdtemp(join(process.cwd(), ".orc-nono-agent-home-"))
await writeFile(join(fixtureHome, ".gitconfig"), "")
const fixtureGitEnv = { PATH: Bun.env.PATH ?? "", HOME: fixtureHome, GIT_CONFIG_GLOBAL: join(fixtureHome, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" }

afterAll(async () => {
  await rm(fixtureHome, { recursive: true, force: true })
})

const git = (args: ReadonlyArray<string>, cwd: string): void => {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: fixtureGitEnv, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error("git " + args.join(" ") + " failed: " + result.stderr.toString())
  }
}

const checkoutWithSession = async (dir: string): Promise<{ readonly worktree: string; readonly session: string }> => {
  const worktree = join(dir, "work")
  const session = join(dir, "session")
  await mkdir(worktree, { recursive: true })
  await mkdir(session, { recursive: true })
  git(["init", "-q"], worktree)
  return { worktree, session }
}

const needsNono = test.skipIf(Bun.which("nono") === null)

describe("the agent directory", () => {
  needsNono(skipReason("needs nono on PATH to create a sandbox", "exposes PI_CODING_AGENT_DIR inside the sandbox", "local"), async () => {
    const dir = await mkdtemp(join(process.cwd(), ".orc-nono-agent-"))
    try {
      const { worktree, session } = await checkoutWithSession(dir)
      const agentDir = join(await realpath(session), "agent")
      await mkdir(agentDir, { recursive: true })
      const handle = await nonoSandboxProvider({ piSessionDir: session }).create({
        worktreePath: worktree,
        hostRepoPath: worktree,
        mounts: [],
        env: { HOME: fixtureHome, PI_CODING_AGENT_DIR: agentDir }
      })
      try {
        const result = await handle.exec("printenv PI_CODING_AGENT_DIR")
        expect(result.exitCode).toBe(0)
        expect(result.stdout.trim()).toBe(agentDir)
      } finally {
        await handle.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  needsNono(skipReason("needs nono on PATH to create a sandbox", "refuses a PI_CODING_AGENT_DIR outside the session dir", "local"), async () => {
    const dir = await mkdtemp(join(process.cwd(), ".orc-nono-agent-"))
    try {
      const { worktree, session } = await checkoutWithSession(dir)
      const outside = join(dir, "elsewhere")
      await mkdir(outside, { recursive: true })
      const error = await nonoSandboxProvider({ piSessionDir: session }).create({
        worktreePath: worktree,
        hostRepoPath: worktree,
        mounts: [],
        env: { HOME: fixtureHome, PI_CODING_AGENT_DIR: outside }
      }).then(async (handle) => {
        await handle.close()
        return null
      }, (cause: unknown) => cause)
      expect(error).toBeInstanceOf(NonoProviderError)
      if (error instanceof NonoProviderError) {
        expect(error.message).toContain("PI_CODING_AGENT_DIR sits outside the session dir")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  needsNono(skipReason("needs nono on PATH to create a sandbox", "defaults PI_CODING_AGENT_DIR to the agent folder under the session dir", "local"), async () => {
    const dir = await mkdtemp(join(process.cwd(), ".orc-nono-agent-"))
    try {
      const { worktree, session } = await checkoutWithSession(dir)
      const handle = await nonoSandboxProvider({ piSessionDir: session }).create({
        worktreePath: worktree,
        hostRepoPath: worktree,
        mounts: [],
        env: { HOME: fixtureHome }
      })
      try {
        const result = await handle.exec("printenv PI_CODING_AGENT_DIR")
        expect(result.exitCode).toBe(0)
        expect(result.stdout.trim()).toBe(join(await realpath(session), "agent"))
      } finally {
        await handle.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("the model credential profile", () => {
  needsNono(skipReason("needs nono on PATH to create a sandbox", "validates the credential profile and runs the sandbox", "local"), async () => {
    const dir = await mkdtemp(join(process.cwd(), ".orc-nono-agent-"))
    try {
      const { worktree, session } = await checkoutWithSession(dir)
      const agentDir = join(await realpath(session), "agent")
      await mkdir(agentDir, { recursive: true })
      const stubPi = join(dir, "pi")
      await writeFile(stubPi, "#!/bin/sh\necho fixture-captured-token\n", { mode: 0o755 })
      const credential = modelCredentialFor("opencode-go/muse-spark", { piBinary: stubPi, nodeBinary: "/bin/sh", homeDir: fixtureHome })
      if (credential === null) {
        throw new Error("the fixture model names no credential")
      }
      const handle = await nonoSandboxProvider({ piSessionDir: session, modelCredential: credential }).create({
        worktreePath: worktree,
        hostRepoPath: worktree,
        mounts: [],
        env: { HOME: fixtureHome, PI_CODING_AGENT_DIR: agentDir }
      })
      try {
        const result = await handle.exec("printenv PI_CODING_AGENT_DIR && echo sandboxed")
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain("sandboxed")
      } finally {
        await handle.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

