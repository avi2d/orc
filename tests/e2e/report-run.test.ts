import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const binPath = new URL("../../packages/run/src/bin.ts", import.meta.url).pathname

const modelListReply = JSON.stringify({ id: "orc-models", type: "response", command: "get_available_models", success: true, data: { models: [{ provider: "acme-go", id: "coder-1", contextWindow: 262144 }] } })

interface ReportFixture {
  readonly repo: string
  readonly orcHome: string
  readonly fakeBin: string
  readonly env: Record<string, string>
}

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

const withReportFixture = async (writesReport: boolean, body: (fixture: ReportFixture) => Promise<void>): Promise<void> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orc-report-run-")))
  const repo = join(root, "repo")
  const orcHome = join(root, "orc-home")
  const fakeBin = join(root, "bin")
  try {
    await mkdir(repo)
    await mkdir(fakeBin)
    await mkdir(orcHome)
    await writeScript(join(fakeBin, "pi"), [
      "if [ \"$1\" = auth ]; then exit 0; fi",
      "if [ \"$1\" = --mode ]; then cat > /dev/null; echo '" + modelListReply + "'; exit 0; fi",
      "if [ \"$1\" != -p ]; then exit 2; fi",
      "cat > \"" + fakeBin + "/pi-prompt\"",
      "echo \"$*\" >> \"" + fakeBin + "/pi-argv\"",
      "pwd > \"" + fakeBin + "/pi-cwd\"",
      ...(writesReport ? ["printf '# Findings\\n\\nThe checkout holds one task file.\\n' > agent-report.md"] : []),
      "echo '{\"type\":\"session\",\"id\":\"0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b\"}'"
    ])
    await writeScript(join(fakeBin, "no-mistakes"), ["echo \"$*\" >> \"" + fakeBin + "/nm-calls\"", "exit 1"])
    await writeScript(join(fakeBin, "nono"), ["echo \"$*\" >> \"" + fakeBin + "/nono-calls\"", "exit 1"])
    const env: Record<string, string> = {
      PATH: fakeBin + ":" + (process.env["PATH"] ?? ""),
      HOME: root,
      ORC_HOME: orcHome,
      ORC_NO_MISTAKES_BIN: join(fakeBin, "no-mistakes")
    }
    git(repo, ["init", "-q"], env)
    git(repo, ["config", "user.name", "orc test"], env)
    git(repo, ["config", "user.email", "orc@test.invalid"], env)
    await writeFile(join(repo, "task.md"), "Say what the checkout holds.\n")
    git(repo, ["add", "task.md"], env)
    git(repo, ["commit", "-qm", "task"], env)
    await writeFile(join(orcHome, "config.json"), JSON.stringify({
      providers: [{ id: "acme-go", credential: "pi-login", nono: { upstream: "https://llm.acme.test/v1" } }],
      models: { implementer: "acme-go/coder-1", fixer: "acme-go/coder-1" }
    }))
    await body({ repo, orcHome, fakeBin, env })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const runOrc = async (args: ReadonlyArray<string>, cwd: string, env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, binPath, ...args], { stdout: "pipe", stderr: "pipe", cwd, env })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}

const scoutRun = ["run", "task.md", "--kind", "scout", "--branch", "orc/task-1", "--sandbox", "none"]

const taskRun = ["run", "task.md", "--kind", "task", "--branch", "orc/task-1", "--sandbox", "none"]

describe("orc run --kind scout", () => {
  test("runs Pi in the run folder and ends on its report, with no no-mistakes call, no PR and no branch", async () => {
    await withReportFixture(true, async ({ repo, orcHome, fakeBin, env }) => {
      const result = await runOrc(scoutRun, repo, env)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
      const runDir = (await readFile(join(fakeBin, "pi-cwd"), "utf8")).trim()
      expect(runDir).toStartWith(join(orcHome, "runs") + "/")
      const report = join(runDir, "agent-report.md")
      expect(result.stdout).toBe("did not refresh " + repo + " because it has no remote, so the run starts from what it holds\norc: scout run " + runDir.split("/").at(-1) + " wrote its report to " + report + "\n")
      expect(await readFile(report, "utf8")).toContain("The checkout holds one task file.")
      expect(await readFile(join(fakeBin, "pi-prompt"), "utf8")).toContain(report)
      expect(await Bun.file(join(fakeBin, "nm-calls")).exists()).toBe(false)
      expect(await Bun.file(join(fakeBin, "nono-calls")).exists()).toBe(false)
      expect(git(repo, ["branch", "--list", "orc/task-1"], env)).toBe("")
      expect(git(repo, ["status", "--porcelain"], env)).toBe("")
      const runs: unknown = JSON.parse((await runOrc(["runs", "--json"], repo, env)).stdout)
      expect(runs).toMatchObject({ runs: [{ branch: "orc/task-1", status: "succeeded", prLink: null }] })
    })
  }, 60_000)

  test("a run whose Pi wrote no report exits failed and records the run failed instead of succeeded", async () => {
    await withReportFixture(false, async ({ repo, env }) => {
      const result = await runOrc(scoutRun, repo, env)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain("pi exited 0 and wrote no report at ")
      const runs: unknown = JSON.parse((await runOrc(["runs", "--json"], repo, env)).stdout)
      expect(runs).toMatchObject({ runs: [{ branch: "orc/task-1", status: "failed" }] })
    })
  }, 60_000)

  test("does not hand Pi the commit-the-result instruction in a scout run", async () => {
    await withReportFixture(true, async ({ repo, fakeBin, env }) => {
      const result = await runOrc(scoutRun, repo, env)
      expect(result.exitCode).toBe(0)
      const prompt = await readFile(join(fakeBin, "pi-prompt"), "utf8")
      expect(prompt).not.toContain("Commit the result")
      expect(prompt).not.toContain("You implement one task")
    })
  }, 60_000)

  test("a scout run without --sandbox none is refused before Pi starts instead of running unsandboxed", async () => {
    await withReportFixture(true, async ({ repo, fakeBin, env }) => {
      const result = await runOrc(["run", "task.md", "--kind", "scout", "--branch", "orc/task-1"], repo, env)
      expect({ exitCode: result.exitCode, stderr: result.stderr.trim() }).toEqual({
        exitCode: 1,
        stderr: "orc: a scout run starts Pi on the host in its run folder, so it takes --sandbox none and refuses --sandbox nono"
      })
      expect(await Bun.file(join(fakeBin, "pi-cwd")).exists()).toBe(false)
    })
  }, 60_000)
})

describe("orc run --kind task", () => {
  test("does not hand Pi the commit-the-result instruction in a task run", async () => {
    await withReportFixture(true, async ({ repo, fakeBin, env }) => {
      const result = await runOrc(taskRun, repo, env)
      expect(result.exitCode).toBe(0)
      const prompt = await readFile(join(fakeBin, "pi-prompt"), "utf8")
      expect(prompt).not.toContain("Commit the result")
      expect(prompt).not.toContain("You implement one task")
    })
  }, 60_000)
})
