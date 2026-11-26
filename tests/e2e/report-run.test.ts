import { bundlePath, ensureBundle } from "./bundle"
import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { addTask } from "../../packages/run/src/entities/backlog/index"
import { answerTask } from "../../packages/run/src/entities/parked-runs/index"
import { readRequest } from "../../packages/run/src/features/queueing-a-task/runner-request"
import { tmpdir } from "node:os"
import { join } from "node:path"

ensureBundle()
const binPath = bundlePath

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

const withReportFixture = async (writesReport: boolean, body: (fixture: ReportFixture) => Promise<void>, unanswered = false): Promise<void> => {
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
      "prev=''; for arg in \"$@\"; do if [ \"$prev\" = --append-system-prompt ]; then cp \"$arg\" \"" + fakeBin + "/pi-instructions\"; fi; prev=$arg; done",
      "echo \"$*\" >> \"" + fakeBin + "/pi-argv\"",
      "pwd > \"" + fakeBin + "/pi-cwd\"",
      ...(unanswered ? [`prev=; for arg in "$@"; do if [ "$prev" = --orc-ask-dir ]; then printf '{"question":"Which answer?","blocks":true}' > "$arg/one.ask.json"; fi; prev=$arg; done`, "sleep 5"] : []),
      ...(writesReport ? ["printf '# Findings\\n\\nThe checkout holds one task file.\\n' > agent-report.md"] : []),
      "echo '{\"type\":\"session\",\"id\":\"0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b\"}'"
    ])
    await writeScript(join(fakeBin, "no-mistakes"), ["echo \"$*\" >> \"" + fakeBin + "/nm-calls\"", "exit 1"])
    await writeScript(join(fakeBin, "nono"), ["echo \"$*\" >> \"" + fakeBin + "/nono-calls\"", "exit 1"])
    const env: Record<string, string> = {
      PATH: fakeBin + ":" + (process.env["PATH"] ?? ""),
      HOME: root,
      ORC_HOME: orcHome,
      ORC_NO_MISTAKES_BIN: join(fakeBin, "no-mistakes"),
      HEAVY_QUEUE_BYPASS: "e2e fixture without a pueue daemon"
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

const effect = <A, E>(run: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> => Effect.runPromise(run.pipe(Effect.provide(BunServices.layer)))

const decisionSpec = {
  project: "orc", kind: "decision" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: null, created: "2026-10-27T10:00:00.000Z"
}

const takeTask = async (backlog: string, id: string): Promise<string> => {
  const taken = join(backlog, "taken", id + ".md")
  const text = await readFile(join(backlog, "new", id + ".md"), "utf8")
  await mkdir(join(backlog, "taken"), { recursive: true })
  await writeFile(taken, text.replace("\n---\n", "\nbeat: \"beat-1\"\ntaken_for: \"mac\"\naccount: \"main\"\ntaken_at: \"2026-11-02T10:01:00.000Z\"\n---\n"))
  await rm(join(backlog, "new", id + ".md"))
  return taken
}

const decidedTaskFile = async (orcHome: string, repo: string): Promise<string> => {
  const backlog = join(orcHome, "backlog")
  const at = "2026-10-27T10:30:00.000Z"
  await effect(addTask(backlog, { ...decisionSpec, title: "Which button goes first", body: "# Which button goes first\n\nThe left one or the right one?\n" }))
  await effect(addTask(backlog, { ...decisionSpec, title: "Which colour", body: "# Which colour\n\nBlue or green?\n" }))
  await effect(addTask(backlog, { ...decisionSpec, kind: "scout", priority: 0, title: "Say what the checkout holds", dependsOn: ["orc-1", "orc-2"], body: "Say what the checkout holds.\n" }))
  await effect(answerTask(backlog, "orc-1", "use the left one", at))
  await effect(answerTask(backlog, "orc-2", "green", at, undefined, "decider"))
  const taken = await takeTask(backlog, "orc-3")
  const request = await effect(readRequest({ ORC_TASK_ID: "orc-3", ORC_TASK_FILE: taken, ORC_TASK_CHECKOUT: repo, ORC_TASK_PROVIDER: "acme-go" }, Effect.succeed("")))
  const file = join(orcHome, "orc-3.md")
  await writeFile(file, request.body)
  return file
}

describe("orc run --kind scout", () => {
  test("runs Pi in the run folder and ends on its report, with no no-mistakes call, no PR and no branch", async () => {
    await withReportFixture(true, async ({ repo, orcHome, fakeBin, env }) => {
      const result = await runOrc(scoutRun, repo, env)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
      const runDir = (await readFile(join(fakeBin, "pi-cwd"), "utf8")).trim()
      expect(runDir).toStartWith(join(orcHome, "runs") + "/")
      const report = join(runDir, "agent-report.md")
      expect(await stat(join(runDir, "session", "agent")).then(() => true, () => false)).toBe(false)
      expect(await Bun.file(join(runDir, "task.md")).exists()).toBe(true)
      expect(await Bun.file(join(runDir, "agent.log")).exists()).toBe(true)
      expect(await stat(join(runDir, "sessions")).then(() => true, () => false)).toBe(true)
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

  test("report.md lists the owner decision and the agent decision a task carries under their own Decided by headings, the agent one with its basis, instead of one mixed list", async () => {
    await withReportFixture(true, async ({ repo, orcHome, fakeBin, env }) => {
      const taskFile = await decidedTaskFile(orcHome, repo)
      const result = await runOrc(["run", taskFile, "--kind", "scout", "--branch", "orc/task-1", "--sandbox", "none"], repo, env)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
      const runDir = (await readFile(join(fakeBin, "pi-cwd"), "utf8")).trim()
      const report = await readFile(join(runDir, "report.md"), "utf8")
      const owner = "Decided by the owner:\n\nDecision orc-1 asked:\n\n# Which button goes first\n\nThe left one or the right one?\n\nOwner answered: use the left one"
      const agent = "Decided by the agent:\n\nDecision orc-2 asked:\n\n# Which colour\n\nBlue or green?\n\nAgent answered: green\nBasis: not recorded"
      expect(report).toContain(owner + "\n\n" + agent)
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

  test("an unanswered question does not leave a failed report run with its Pi agent folder", async () => {
    await withReportFixture(false, async ({ repo, env, fakeBin }) => {
      const result = await runOrc(scoutRun, repo, { ...env, ORC_ANSWER_WAIT_SECONDS: "1" })
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain("no answer to its question")
      const runDir = (await readFile(join(fakeBin, "pi-cwd"), "utf8")).trim()
      expect(await Bun.file(join(runDir, "task.md")).exists()).toBe(true)
      expect(await Bun.file(join(runDir, "agent.log")).exists()).toBe(true)
      expect(await stat(join(runDir, "sessions")).then(() => true, () => false)).toBe(true)
      expect(await stat(join(runDir, "session", "agent")).then(() => true, () => false)).toBe(false)
    }, true)
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

  test("with --instructions names the file on the first output line and hands Pi its words instead of running without them", async () => {
    await withReportFixture(true, async ({ repo, fakeBin, env }) => {
      const instructions = join(repo, "..", "orc-instructions.md")
      await writeFile(instructions, "Write the report in the voice of a PELICAN.\n")
      const result = await runOrc([...scoutRun, "--instructions", instructions], repo, env)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.split("\n")[0]).toBe("orc run loaded the instructions in " + instructions)
      expect(await readFile(join(fakeBin, "pi-instructions"), "utf8")).toBe("Write the report in the voice of a PELICAN.\n")
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

  test("records the claimed ORC_RUN_MACHINE machine instead of the OS host name when no dispatch.json exists on the run machine", async () => {
    await withReportFixture(true, async ({ repo, env }) => {
      const result = await runOrc(scoutRun, repo, { ...env, ORC_RUN_MACHINE: "linux-box", HOSTNAME: "Some-MacBook-Pro.local" })
      expect(result.exitCode).toBe(0)
      const runs: unknown = JSON.parse((await runOrc(["runs", "--json"], repo, env)).stdout)
      expect(runs).toMatchObject({ runs: [{ branch: "orc/task-1", machine: "linux-box", worktree: repo }] })
    })
  }, 60_000)

  test("without a queue bypass a run fails naming the heavy queue instead of running unqueued", async () => {
    await withReportFixture(true, async ({ repo, fakeBin, env }) => {
      const result = await runOrc(scoutRun, repo, { ...env, HEAVY_QUEUE_BYPASS: "" })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("orc: the heavy queue failed to start")
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

describe("orc run --kind parent", () => {
  test("a final check whose report does not end in verdict: pass records the run failed instead of succeeded", async () => {
    await withReportFixture(true, async ({ repo, fakeBin, env }) => {
      const result = await runOrc(["run", "task.md", "--kind", "parent", "--branch", "orc/task-1", "--sandbox", "none"], repo, env)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain("the final check did not end its report at ")
      const prompt = await readFile(join(fakeBin, "pi-prompt"), "utf8")
      expect(prompt).toContain("review no code")
      expect(prompt).toContain("verdict: pass")
      expect(await Bun.file(join(fakeBin, "nm-calls")).exists()).toBe(false)
      const runs: unknown = JSON.parse((await runOrc(["runs", "--json"], repo, env)).stdout)
      expect(runs).toMatchObject({ runs: [{ branch: "orc/task-1", status: "failed" }] })
    })
  }, 60_000)
})

