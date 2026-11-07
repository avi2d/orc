import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { skipReason } from "@avi2dg/checks/scripts/test-skips.ts"
import { NonoProviderError } from "../../packages/run/src/host"
import type { NonoExecOptions } from "../../packages/run/src/nono-exec"
import { modelCredentialFor, type ModelCredential } from "../../packages/run/src/nono-profile"
import { nonoOpenError, runNonoShell } from "../lib/nono-shell"

const systemTempRoots = ["/tmp", "/private/tmp", "/var", "/private/var"]
const underSystemTemp = (candidate: string): boolean =>
  systemTempRoots.some((root) => candidate === root || candidate.startsWith(root + "/"))
const homeBase = (cwd: string, systemTmp: string): string =>
  !underSystemTemp(cwd) ? cwd : (!underSystemTemp(systemTmp) ? systemTmp : cwd)
const fixtureHome = await mkdtemp(join(homeBase(process.cwd(), tmpdir()), ".orc-nono-agent-home-"))
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

interface SandboxFor {
  readonly worktree: string
  readonly session: string
  readonly piAgentDir?: string
  readonly modelCredential?: ModelCredential
  readonly hostEnv?: Readonly<Record<string, string>>
}

const sandboxFor = (sandbox: SandboxFor): NonoExecOptions => ({
  worktree: sandbox.worktree,
  piSessionDir: sandbox.session,
  sessionsDir: sandbox.session,
  piAgentDir: sandbox.piAgentDir,
  modelCredential: sandbox.modelCredential,
  hostEnv: { ...Bun.env, HOME: fixtureHome, ...sandbox.hostEnv },
  readFolders: [],
  env: {}
})

const noNono = Bun.which("nono") === null
const insideSandbox = Bun.env.PI_SESSION_FILE !== undefined || Bun.env.NONO_CAP_FILE !== undefined

// Starting a nono sandbox runs past bun's 5s default while the rest of the suite runs beside it.
const sandboxTimeout = 30_000

describe("the agent directory", () => {
  test.skipIf(noNono || insideSandbox)(skipReason("needs nono on PATH to create a sandbox", "exposes the agent dir the caller passes inside the sandbox"), async () => {
    const dir = await mkdtemp(join(process.cwd(), ".orc-nono-agent-"))
    try {
      const { worktree, session } = await checkoutWithSession(dir)
      const agentDir = join(await realpath(session), "pi-agent")
      await mkdir(agentDir, { recursive: true })
      const result = await runNonoShell(sandboxFor({ worktree, session, piAgentDir: agentDir }), "printenv PI_CODING_AGENT_DIR")
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe(agentDir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, sandboxTimeout)

  test.skipIf(noNono)(skipReason("needs nono on PATH to create a sandbox", "refuses an agent dir outside the session dir"), async () => {
    const dir = await mkdtemp(join(process.cwd(), ".orc-nono-agent-"))
    try {
      const { worktree, session } = await checkoutWithSession(dir)
      const outside = join(dir, "elsewhere")
      await mkdir(outside, { recursive: true })
      const error = await nonoOpenError(sandboxFor({ worktree, session, piAgentDir: outside }))
      expect(error).toBeInstanceOf(NonoProviderError)
      if (error instanceof NonoProviderError) {
        expect(error.message).toContain("PI_CODING_AGENT_DIR sits outside the session dir")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, sandboxTimeout)

  test.skipIf(noNono || insideSandbox)(skipReason("needs nono on PATH to create a sandbox", "ignores an ambient PI_CODING_AGENT_DIR and uses the agent folder under the session dir"), async () => {
    const dir = await mkdtemp(join(process.cwd(), ".orc-nono-agent-"))
    try {
      const { worktree, session } = await checkoutWithSession(dir)
      const ambient = join(dir, "operator-agent")
      await mkdir(ambient, { recursive: true })
      const result = await runNonoShell(sandboxFor({ worktree, session, hostEnv: { PI_CODING_AGENT_DIR: ambient } }), "printenv PI_CODING_AGENT_DIR")
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe(join(await realpath(session), "agent"))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, sandboxTimeout)
})

describe("the nono credential proxy", () => {
  test.skipIf(noNono || insideSandbox)(skipReason("needs nono on PATH to create a sandbox", "sends a placeholder or Bearer value instead of the captured key under X-Api-Key"), async () => {
    const dir = await mkdtemp(join(process.cwd(), ".orc-nono-proxy-"))
    let server: ReturnType<typeof Bun.serve> | null = null
    try {
      const { worktree, session } = await checkoutWithSession(dir)
      const agentDir = join(await realpath(session), "agent")
      await mkdir(agentDir, { recursive: true })
      const fixtureKey = "<fixture-key>"
      const seen: Record<string, string | null> = {}
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          seen["x-api-key"] = request.headers.get("x-api-key")
          seen["authorization"] = request.headers.get("authorization")
          return new Response("proxy-ok\n")
        }
      })
      const upstream = "http://127.0.0.1:" + server.port + "/v1"
      const stubPi = join(dir, "pi")
      await writeFile(stubPi, "#!/bin/sh\nif [ \"$1\" = auth ]; then echo \"" + fixtureKey + "\"; exit 0; fi\nexit 2\n", { mode: 0o755 })
      const credential = modelCredentialFor({ id: "acme-vault", upstream, injectHeader: "X-Api-Key", credentialFormat: "{}" }, { piBinary: stubPi, nodeBinary: "/bin/sh", homeDir: fixtureHome })
      const result = await runNonoShell(sandboxFor({ worktree, session, piAgentDir: agentDir, modelCredential: credential }), "curl -s --max-time 10 '" + upstream + "/probe'")
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("proxy-ok")
      expect(seen["x-api-key"]).toBe(fixtureKey)
      expect(seen["x-api-key"]).not.toBe("$ACME_VAULT_KEY")
      expect(seen["authorization"]).toBeNull()
    } finally {
      await server?.stop(true)
      await rm(dir, { recursive: true, force: true })
    }
  }, sandboxTimeout)
})

describe("the model credential profile", () => {
  test.skipIf(noNono || insideSandbox)(skipReason("needs nono on PATH to create a sandbox", "validates the credential profile and runs the sandbox"), async () => {
    const dir = await mkdtemp(join(process.cwd(), ".orc-nono-agent-"))
    try {
      const { worktree, session } = await checkoutWithSession(dir)
      const agentDir = join(await realpath(session), "agent")
      await mkdir(agentDir, { recursive: true })
      const stubPi = join(dir, "pi")
      await writeFile(stubPi, "#!/bin/sh\necho fixture-captured-token\n", { mode: 0o755 })
      const credential = modelCredentialFor({ id: "acme-go", upstream: "https://llm.acme.test/v1" }, { piBinary: stubPi, nodeBinary: "/bin/sh", homeDir: fixtureHome })
      const result = await runNonoShell(sandboxFor({ worktree, session, piAgentDir: agentDir, modelCredential: credential }), "printenv PI_CODING_AGENT_DIR && echo sandboxed")
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("sandboxed")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, sandboxTimeout)
})

