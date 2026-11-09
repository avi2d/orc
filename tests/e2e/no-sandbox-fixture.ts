import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { orcCompletionLine } from "../../packages/run/src/pi"

export const binPath = new URL("../../packages/run/src/bin.ts", import.meta.url).pathname

const sessionId = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"

export const prUrl = "https://github.com/o/r/pull/7"

const sessionJsonl = [
  JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-10-28T10:00:00.000Z", cwd: "/repo" }),
  JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Committed.\n" + orcCompletionLine }], stopReason: "stop", usage: { input: 50, output: 5 } } })
].join("\n") + "\n"

const piStream = [
  JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-10-28T10:00:00.000Z", cwd: "/repo" }),
  JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Committed.\n" + orcCompletionLine } })
].join("\n") + "\n"

const modelListReply = JSON.stringify({ id: "orc-models", type: "response", command: "get_available_models", success: true, data: { models: [{ provider: "acme-go", id: "coder-1", contextWindow: 262144 }, { provider: "keyed", id: "coder-2", contextWindow: 200000 }, { provider: "bridged", id: "coder-3", contextWindow: 400000 }] } })

export const fixtureToken = "sk-orc-e2e-fixture-token"

export const loginProvider = { id: "acme-go", credential: "pi-login", nono: { upstream: "https://llm.acme.test/v1" } }

export const keyedProvider = { id: "keyed", credential: "token-file", tokenFile: { env: "KEYED_TOKEN_FILE" } }

const noMistakesReplies = [
  ["run:", "  id: \"01STUB\"", "  branch: orc/test", "  status: completed", "  head: abc1234", "  pr: \"" + prUrl + "\"", "  findings: none", "outcome: passed"],
  ["run:", "  id: \"01STUB\"", "  branch: orc/test", "  status: running", "  pr: \"" + prUrl + "\"", "  steps[2]{step,status,findings,duration_ms}:", "    review,completed,0,3928", "    ci,running,0,0"]
].map((lines) => lines.join("\n") + "\n")

export const git = (dir: string, args: ReadonlyArray<string>, env: Record<string, string>): string => {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir, env })
  if (result.exitCode !== 0) {
    throw new Error("the git fixture failed: git " + args.join(" ") + ": " + result.stderr.toString())
  }
  return result.stdout.toString().trim()
}

export const writeScript = async (file: string, lines: ReadonlyArray<string>): Promise<void> => {
  await writeFile(file, ["#!/bin/sh", ...lines].join("\n") + "\n")
  await chmod(file, 0o755)
}

export interface NoSandboxFixture {
  readonly repo: string
  readonly home: string
  readonly fakeBin: string
  readonly env: Record<string, string>
}

export const withNoSandboxFixture = async (body: (fixture: NoSandboxFixture) => Promise<void>): Promise<void> => {
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
      "if [ \"$1\" = --mode ]; then echo \"$*\" >> \"" + fakeBin + "/probe-argv\"; cat > /dev/null; echo '" + modelListReply + "'; exit 0; fi",
      "if [ \"$1\" != -p ]; then exit 2; fi",
      "cat > /dev/null",
      "prev=''; for arg in \"$@\"; do if [ \"$prev\" = --append-system-prompt ]; then cp \"$arg\" \"" + fakeBin + "/pi-instructions\"; fi; if [ \"$prev\" = --session-dir ]; then session_dir=$arg; fi; prev=$arg; done",
      "echo \"$PI_CODING_AGENT_DIR\" > \"" + fakeBin + "/pi-agent-dir\"",
      "if [ -f \"$PI_CODING_AGENT_DIR/models.json\" ]; then cp \"$PI_CODING_AGENT_DIR/models.json\" \"" + fakeBin + "/pi-models\"; fi",
      "if [ -f \"$PI_CODING_AGENT_DIR/settings.json\" ]; then cp \"$PI_CODING_AGENT_DIR/settings.json\" \"" + fakeBin + "/pi-settings\"; fi",
      "echo \"$ACME_ACCOUNT_DIR\" > \"" + fakeBin + "/pi-account-dir\"",
      "echo \"$AGENT_TOKEN_FILE\" > \"" + fakeBin + "/pi-token-file\"",
      "pwd > \"" + fakeBin + "/pi-cwd\"",
      "git rev-parse --show-toplevel --path-format=absolute --git-common-dir --abbrev-ref HEAD > \"" + fakeBin + "/pi-git\"",
      "echo \"$GIT_CONFIG_GLOBAL\" > \"" + fakeBin + "/pi-gitconfig\"",
      "echo hello > greeting.txt && git add greeting.txt && git commit -qm 'add greeting' || exit 1",
      "mkdir -p \"$session_dir\"",
      "cp \"" + fakeBin + "/session.jsonl\" \"$session_dir/2026-10-28T10-00-00-000Z_" + sessionId + ".jsonl\"",
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
      ORC_NO_MISTAKES_BIN: join(fakeBin, "no-mistakes"),
      HEAVY_QUEUE_BYPASS: "e2e fixture without a pueue daemon"
    }
    git(repo, ["init", "-q"], env)
    git(repo, ["config", "user.name", "orc test"], env)
    git(repo, ["config", "user.email", "orc@test.invalid"], env)
    await writeFile(join(repo, "task.md"), "Create greeting.txt.\n")
    await writeFile(join(repo, ".no-mistakes.yaml"), "commands:\n  greeting: test -f greeting.txt\n")
    git(repo, ["add", "task.md", ".no-mistakes.yaml"], env)
    git(repo, ["commit", "-qm", "task"], env)
    await writeConfig(env, { providers: [loginProvider, keyedProvider], models: { implementer: "acme-go/coder-1", fixer: "acme-go/coder-1" } })
    await body({ repo, home, fakeBin, env })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export const writeConfig = async (env: Record<string, string>, config: unknown): Promise<void> => {
  const orcHome = env["ORC_HOME"] ?? ""
  await mkdir(orcHome, { recursive: true })
  await writeFile(join(orcHome, "config.json"), JSON.stringify(config))
}

export const runOrc = async (args: ReadonlyArray<string>, cwd: string, env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, binPath, ...args], { stdout: "pipe", stderr: "pipe", cwd, env })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}
