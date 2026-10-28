import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { orcCompletionLine } from "../../packages/run/src/pi"

const binPath = new URL("../../packages/run/src/bin.ts", import.meta.url).pathname

const sessionId = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
const prUrl = "https://github.com/o/r/pull/7"

const sessionJsonl = [
  JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-10-28T10:00:00.000Z", cwd: "/repo" }),
  JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Committed.\n" + orcCompletionLine }], stopReason: "stop", usage: { input: 50, output: 5 } } })
].join("\n") + "\n"

const piStream = [
  JSON.stringify({ type: "session", id: sessionId }),
  JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Committed.\n" + orcCompletionLine } })
].join("\n") + "\n"

const claudeModel = "claude-sonnet-4-5"

const modelListReply = JSON.stringify({ id: "orc-models", type: "response", command: "get_available_models", success: true, data: { models: [{ provider: "opencode-go", id: "muse-spark-1.3-contributor", contextWindow: 262144 }, { provider: "anthropic", id: claudeModel, contextWindow: 200000 }] } })

const claudeToken = "sk-ant-oat01-orc-e2e-fixture-token"

const decodeClaudeModels = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ providers: Schema.Struct({ anthropic: Schema.Struct({ apiKey: Schema.String }) }) })))

const noMistakesReplies = [
  ["run:", "  id: \"01STUB\"", "  branch: orc/test", "  status: completed", "  head: abc1234", "  pr: \"" + prUrl + "\"", "  findings: none", "outcome: passed"],
  ["run:", "  id: \"01STUB\"", "  branch: orc/test", "  status: running", "  pr: \"" + prUrl + "\"", "  steps[2]{step,status,findings,duration_ms}:", "    review,completed,0,3928", "    ci,running,0,0"]
].map((lines) => lines.join("\n") + "\n")

const git = (dir: string, args: ReadonlyArray<string>, env: Record<string, string>): string => {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir, env })
  if (result.exitCode !== 0) {
    throw new Error("the git fixture failed: git " + args.join(" ") + ": " + result.stderr.toString())
  }
  return result.stdout.toString().trim()
}

const writeScript = async (file: string, lines: ReadonlyArray<string>): Promise<void> => {
  await writeFile(file, ["#!/bin/sh", ...lines].join("\n") + "\n")
  await chmod(file, 0o755)
}

interface NoSandboxFixture {
  readonly repo: string
  readonly home: string
  readonly fakeBin: string
  readonly env: Record<string, string>
}

const withNoSandboxFixture = async (body: (fixture: NoSandboxFixture) => Promise<void>): Promise<void> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orc-no-sandbox-")))
  const repo = join(root, "repo")
  const home = join(root, "home")
  const fakeBin = join(root, "bin")
  try {
    await mkdir(repo)
    await mkdir(home)
    await mkdir(fakeBin)
    await writeFile(join(fakeBin, "session.jsonl"), sessionJsonl)
    await writeFile(join(fakeBin, "stream.jsonl"), piStream)
    await writeScript(join(fakeBin, "pi"), [
      "if [ \"$1\" = auth ]; then exit 0; fi",
      "if [ \"$1\" = --mode ]; then cat > /dev/null; echo '" + modelListReply + "'; exit 0; fi",
      "if [ \"$1\" != -p ]; then exit 2; fi",
      "cat > /dev/null",
      "echo \"$PI_CODING_AGENT_DIR\" > \"" + fakeBin + "/pi-agent-dir\"",
      "if [ -f \"$PI_CODING_AGENT_DIR/models.json\" ]; then cp \"$PI_CODING_AGENT_DIR/models.json\" \"" + fakeBin + "/pi-models\"; fi",
      "pwd > \"" + fakeBin + "/pi-cwd\"",
      "git rev-parse --show-toplevel --path-format=absolute --git-common-dir --abbrev-ref HEAD > \"" + fakeBin + "/pi-git\"",
      "echo \"$GIT_CONFIG_GLOBAL\" > \"" + fakeBin + "/pi-gitconfig\"",
      "echo hello > greeting.txt && git add greeting.txt && git commit -qm 'add greeting' || exit 1",
      "mkdir -p \"$PI_CODING_AGENT_SESSION_DIR\"",
      "cp \"" + fakeBin + "/session.jsonl\" \"$PI_CODING_AGENT_SESSION_DIR/2026-10-28T10-00-00-000Z_" + sessionId + ".jsonl\"",
      "cat \"" + fakeBin + "/stream.jsonl\""
    ])
    await writeScript(join(fakeBin, "nono"), ["echo \"$*\" >> \"" + fakeBin + "/nono-calls\"", "exit 1"])
    const repliesDir = join(fakeBin, "replies")
    await mkdir(repliesDir)
    for (const [index, reply] of noMistakesReplies.entries()) {
      await writeFile(join(repliesDir, (index + 1).toString()), reply)
    }
    await writeFile(join(fakeBin, "count"), "1")
    await writeScript(join(fakeBin, "no-mistakes"), [
      "if [ \"$1\" = --version ]; then echo 'no-mistakes version v1.100.2'; exit 0; fi",
      "echo \"$* @ $(pwd)\" >> \"" + fakeBin + "/nm-calls\"",
      "n=$(cat \"" + fakeBin + "/count\")",
      "echo $((n + 1)) > \"" + fakeBin + "/count\"",
      "if [ ! -f \"" + repliesDir + "/$n\" ]; then echo 'unexpected no-mistakes call' >&2; exit 1; fi",
      "cat \"" + repliesDir + "/$n\""
    ])
    const env: Record<string, string> = {
      PATH: fakeBin + ":" + (process.env["PATH"] ?? ""),
      HOME: home,
      ORC_HOME: join(root, "orc-home"),
      ORC_NO_MISTAKES_BIN: join(fakeBin, "no-mistakes")
    }
    git(repo, ["init", "-q"], env)
    git(repo, ["config", "user.name", "orc test"], env)
    git(repo, ["config", "user.email", "orc@test.invalid"], env)
    await writeFile(join(repo, "task.md"), "Create greeting.txt.\n")
    await writeFile(join(repo, ".no-mistakes.yaml"), "commands:\n  greeting: test -f greeting.txt\n")
    git(repo, ["add", "task.md", ".no-mistakes.yaml"], env)
    git(repo, ["commit", "-qm", "task"], env)
    await body({ repo, home, fakeBin, env })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const writeAgentFile = (file: string, model: string): Promise<void> =>
  writeFile(file, "---\nmodel: " + model + "\nthinking: low\ntools: read, bash, edit\n---\nDo the task.\n")

const asClaudeRun = async (fixture: NoSandboxFixture, tokenMode: number): Promise<Record<string, string>> => {
  const agentsDir = join(fixture.env["ORC_HOME"] ?? "", "agents")
  await mkdir(agentsDir, { recursive: true })
  await writeAgentFile(join(agentsDir, "implementer.md"), "anthropic/" + claudeModel)
  await writeAgentFile(join(agentsDir, "fixer.md"), "anthropic/" + claudeModel)
  const secretDir = join(fixture.home, "..", "secret")
  await mkdir(secretDir, { mode: 0o700 })
  const tokenFile = join(secretDir, "claude-token")
  await writeFile(tokenFile, claudeToken)
  await chmod(tokenFile, tokenMode)
  return { ...fixture.env, ORC_CLAUDE_TOKEN_FILE: tokenFile }
}

const filesUnder = async (dir: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
}

const filesHolding = async (dirs: ReadonlyArray<string>, needle: string): Promise<ReadonlyArray<string>> => {
  const holding: Array<string> = []
  for (const dir of dirs) {
    for (const file of await filesUnder(dir)) {
      if ((await readFile(file)).includes(needle)) {
        holding.push(file)
      }
    }
  }
  return holding
}

const runOrc = async (args: ReadonlyArray<string>, cwd: string, env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, binPath, ...args], { stdout: "pipe", stderr: "pipe", cwd, env })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}

describe("orc run --sandbox none", () => {
  test("runs Pi on the host in its own worktree, without nono and without writing the operator's git config, to one PR", async () => {
    await withNoSandboxFixture(async ({ repo, home, fakeBin, env }) => {
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], repo, env)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) })
      expect(result.stdout).toContain(prUrl)
      const piCwd = (await readFile(join(fakeBin, "pi-cwd"), "utf8")).trim()
      expect(piCwd).not.toBe(repo)
      expect((await readFile(join(fakeBin, "pi-git"), "utf8")).trim().split("\n")).toEqual([piCwd, join(repo, ".git"), "orc/test"])
      expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"], env)).not.toBe("orc/test")
      expect(git(repo, ["log", "orc/test", "--format=%s"], env).split("\n")).toEqual(["add greeting", "task"])
      const nmCalls = (await readFile(join(fakeBin, "nm-calls"), "utf8")).split("\n").filter((line) => line !== "")
      expect(nmCalls.filter((line) => line.startsWith("axi run")).length).toBe(1)
      expect(nmCalls.every((line) => line.endsWith(" @ " + piCwd))).toBe(true)
      expect(await Bun.file(join(fakeBin, "nono-calls")).exists()).toBe(false)
      expect(await Bun.file(join(home, ".gitconfig")).exists()).toBe(false)
      expect((await readFile(join(fakeBin, "pi-gitconfig"), "utf8")).trim()).toStartWith(env["ORC_HOME"] ?? "")
    })
  }, 60_000)

  test("without --sandbox the run still takes nono instead of running unsandboxed", async () => {
    await withNoSandboxFixture(async ({ repo, fakeBin, env }) => {
      const result = await runOrc(["run", "task.md", "--branch", "orc/test"], repo, env)
      expect(result.exitCode).not.toBe(0)
      expect(await Bun.file(join(fakeBin, "pi-cwd")).exists()).toBe(false)
    })
  }, 60_000)
})

describe("orc run on a Claude model", () => {
  test("hands Pi a run-owned agent folder whose key reads the token file, ends in one PR and leaves the token in no run, repo or home file", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const env = await asClaudeRun(fixture, 0o600)
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], fixture.repo, env)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) })
      expect(result.stdout).toContain(prUrl)
      const nmCalls = (await readFile(join(fixture.fakeBin, "nm-calls"), "utf8")).split("\n").filter((line) => line !== "")
      expect(nmCalls.filter((line) => line.startsWith("axi run")).length).toBe(1)
      const agentDir = (await readFile(join(fixture.fakeBin, "pi-agent-dir"), "utf8")).trim()
      expect(agentDir).toStartWith((env["ORC_HOME"] ?? "") + "/")
      const apiKey = decodeClaudeModels(await readFile(join(fixture.fakeBin, "pi-models"), "utf8")).providers.anthropic.apiKey
      expect(apiKey).toStartWith("!")
      const resolved = Bun.spawnSync(["sh", "-c", apiKey.slice(1)], { env })
      expect(resolved.stdout.toString()).toBe(claudeToken)
      expect(await filesHolding([env["ORC_HOME"] ?? "", fixture.repo, fixture.home], claudeToken)).toEqual([])
      expect(git(fixture.repo, ["log", "--all", "-p"], env)).not.toContain(claudeToken)
      expect(await Bun.file(join(fixture.fakeBin, "nono-calls")).exists()).toBe(false)
    })
  }, 60_000)

  test("in the nono sandbox is refused before Pi runs, naming --sandbox none", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const env = await asClaudeRun(fixture, 0o600)
      const result = await runOrc(["run", "task.md", "--branch", "orc/test"], fixture.repo, env)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("--sandbox none")
      expect(await Bun.file(join(fixture.fakeBin, "pi-cwd")).exists()).toBe(false)
    })
  }, 60_000)

  test("with a token file other users can read is refused before Pi runs", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const env = await asClaudeRun(fixture, 0o644)
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], fixture.repo, env)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("has mode 644")
      expect(await Bun.file(join(fixture.fakeBin, "pi-cwd")).exists()).toBe(false)
    })
  }, 60_000)
})
