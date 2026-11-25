import { describe, expect, test } from "bun:test"
import { chmod, exists, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import packageJson from "../../packages/run/package.json" with { type: "json" }
import { openDatabase, recordRun, recordStep } from "../../packages/run/src/entities/run-history/index"
import { decodeShowJson } from "../../packages/run/src/features/seeing-runs/index"

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const windows = process.platform === "win32"
const compiledOrc = join(repoRoot, "packages", "run", "dist", windows ? "orc.exe" : "orc")
const sourceOrc = [process.execPath, join(repoRoot, "packages", "run", "src", "bin.ts")]
const compileTimeout = 300_000

interface Ran {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

// Windows names PATH as Path, and an environment holding both spellings leaves the child either one.
const overlay = (env: Record<string, string>): Record<string, string | undefined> => {
  const replaced = new Set(Object.keys(env).map((key) => key.toUpperCase()))
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !replaced.has(key.toUpperCase()))), ...env }
}

const run = async (command: ReadonlyArray<string>, env: Record<string, string>, cwd: string): Promise<Ran> => {
  const proc = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd, env: overlay(env) })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}

const quotaScript = "console.log(JSON.stringify({ schema: \"orc.quota.v1\", accounts: [{ name: \"main\", remainingPercent: 50 }] }))"

// ORC_CHAT_ORC names each build's own path, so the pi that compares builds does not print it.
const piScript = (quiet: boolean): string => [
  ...(quiet ? [] : ["console.log(\"ORC_CHAT_ORC=\" + process.env.ORC_CHAT_ORC)"]),
  "process.exit(Bun.spawnSync([...JSON.parse(process.env.ORC_CHAT_ORC ?? \"[]\"), \"--version\"], { stdout: \"inherit\", stderr: \"inherit\" }).exitCode)",
  ""
].join("\n")

let compiling: Promise<void> | undefined

const compileOrc = (): Promise<void> => compiling ??= run([process.execPath, "run", "compile"], {}, repoRoot).then((compiled) => {
  if (compiled.exitCode !== 0) {
    throw new Error("bun run compile exited " + compiled.exitCode + ": " + compiled.stderr)
  }
})

// A beat names itself with a random id and stamps the clock, so only those two fields may differ between builds.
const unstamped = (ran: Ran): Ran => {
  const report: unknown = JSON.parse(ran.stdout)
  if (typeof report !== "object" || report === null) {
    throw new Error("beat --json printed no object: " + ran.stdout)
  }
  return { ...ran, stdout: JSON.stringify(Object.fromEntries(Object.entries(report).filter(([key]) => key !== "beat" && key !== "at"))) }
}

// Windows starts a fake tool only through an extension it knows, and a .cmd file needs no compiling.
const writeFakePi = async (bin: string, quiet: boolean): Promise<void> => {
  const script = join(bin, "pi.js")
  await writeFile(script, piScript(quiet))
  if (windows) {
    await writeFile(join(bin, "pi.cmd"), "@\"" + process.execPath + "\" \"" + script + "\" %*\r\n")
    return
  }
  await writeFile(join(bin, "pi"), "#!/bin/sh\nexec '" + process.execPath + "' '" + script + "' \"$@\"\n")
  await chmod(join(bin, "pi"), 0o755)
}

interface Fixture {
  readonly dir: string
  readonly env: Record<string, string>
}

const withFixture = async (body: (fixture: Fixture) => Promise<void>, quiet = false): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-compiled-e2e-"))
  try {
    const home = join(dir, "home")
    const bin = join(dir, "bin")
    await mkdir(join(home, "backlog"), { recursive: true })
    await mkdir(bin)
    await writeFile(join(home, "backlog", "dispatch.json"), JSON.stringify({
      machines: [],
      quota: { provider: "acme", command: [process.execPath, "-e", quotaScript], accounts: [{ name: "main", kind: "none" }], floorPercent: 15 }
    }))
    await writeFile(join(home, "backlog", "projects.json"), JSON.stringify({ projects: [] }))
    await writeFile(join(home, "config.json"), JSON.stringify({ providers: [], models: { orchestrator: "acme/orchestrator-1" } }))
    await writeFakePi(bin, quiet)
    await body({ dir, env: { ORC_HOME: home, PATH: bin + delimiter + (process.env.PATH ?? "") } })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const seedRun = async (home: string): Promise<void> => {
  const db = await Effect.runPromise(openDatabase(home).pipe(Effect.provide(BunServices.layer)))
  try {
    await Effect.runPromise(recordRun(db, {
      id: "compiled-1",
      project: "orc",
      branch: "orc/compiled",
      taskFile: join(home, "runs", "compiled-1", "task.md"),
      status: "succeeded",
      started: "2026-11-24T10:00:00.000Z",
      ended: "2026-11-24T10:05:00.000Z",
      prLink: null,
      endReason: "done"
    }))
    await Effect.runPromise(recordStep(db, {
      runId: "compiled-1",
      name: "implement",
      attempt: 1,
      status: "passed",
      started: "2026-11-24T10:00:00.000Z",
      ended: "2026-11-24T10:01:00.000Z",
      agentFile: null,
      piSessionFile: null
    }))
  } finally {
    db.close()
  }
}

describe("compiled orc", () => {
  test("bun run compile builds one bytecode file that answers help, beat, score, show, chat's self command, embeds chat tools, and reads its embedded agent file on POSIX", async () => {
    await compileOrc()
    await withFixture(async ({ dir, env }) => {
      const orc = (args: ReadonlyArray<string>) => run([compiledOrc, ...args], env, dir)

      const help = await orc(["--help"])
      expect(help.exitCode).toBe(0)
      expect(help.stdout).toContain("Usage: orc <command>")

      const beat = await orc(["beat", "--json"])
      expect(beat.stderr).toBe("")
      expect(beat.exitCode).toBe(0)
      expect(JSON.parse(beat.stdout)).toMatchObject({ schema: "orc.beat.v1", quota: { kind: "read", pick: "main" }, room: [], actions: [] })

      await seedRun(env.ORC_HOME)
      const score = await orc(["score", "compiled-1", "implement", "4", "bytecode"])
      expect(score.stderr).toBe("")
      expect(score.stdout).toContain("orc score recorded 4 for implement in compiled-1")
      const show = await orc(["show", "compiled-1", "--json"])
      expect(show.exitCode).toBe(0)
      const document = await Effect.runPromise(decodeShowJson(JSON.parse(show.stdout)))
      expect(document.steps.map((step) => [step.name, step.score?.score, step.score?.note])).toEqual([["implement", 4, "bytecode"]])

      const chat = await orc(["chat"])
      expect(chat.stderr).toBe("")
      expect(chat.exitCode).toBe(0)
      expect(chat.stdout).toContain("ORC_CHAT_ORC=" + JSON.stringify([await realpath(compiledOrc)]))
      expect(chat.stdout).toContain("orc " + packageJson.version)
      expect(await exists(join(env.ORC_HOME, "chat-tools.js"))).toBe(true)

      // orc run starts git through a #!/bin/sh shim that Windows cannot start, so only POSIX reaches the embedded agent file.
      if (windows) {
        return
      }

      const repo = join(dir, "repo")
      await mkdir(repo)
      await writeFile(join(repo, "task.md"), "Do nothing.\n")
      for (const args of [["init", "-q"], ["add", "task.md"], ["-c", "user.name=orc", "-c", "user.email=orc@example.com", "commit", "-qm", "task"]]) {
        expect((await run(["git", ...args], {}, repo)).exitCode).toBe(0)
      }
      const agent = await run([compiledOrc, "run", "task.md"], { ...env, HEAVY_QUEUE_BYPASS: "compiled e2e fixture without a pueue daemon" }, repo)
      expect(agent.exitCode).not.toBe(0)
      expect(agent.stdout + agent.stderr).toMatch(/the agent file \/\$bunfs\/root\/implementer-\w+\.md names no model/)
    })
  }, compileTimeout)

  test("the compiled file gives the same exit code and output as the source for help, beat, show and chat", async () => {
    await compileOrc()
    await withFixture(async ({ dir, env }) => {
      await seedRun(env.ORC_HOME)
      const both = async (args: ReadonlyArray<string>) => ({
        source: await run([...sourceOrc, ...args], env, dir),
        compiled: await run([compiledOrc, ...args], env, dir)
      })

      const help = await both(["--help"])
      expect(help.compiled).toEqual(help.source)

      const beat = await both(["beat", "--json"])
      expect(beat.source.exitCode).toBe(0)
      expect(unstamped(beat.compiled)).toEqual(unstamped(beat.source))

      const show = await both(["show", "compiled-1", "--json"])
      expect(show.source.exitCode).toBe(0)
      expect(show.compiled).toEqual(show.source)

      const chat = await both(["chat"])
      expect(chat.source.exitCode).toBe(0)
      expect(chat.compiled).toEqual(chat.source)
    }, true)
  }, compileTimeout)
})
