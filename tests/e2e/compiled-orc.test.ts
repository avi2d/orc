import { describe, expect, test } from "bun:test"
import { chmod, exists, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import packageJson from "../../packages/run/package.json" with { type: "json" }
import { openDatabase, recordRun, recordStep } from "../../packages/run/src/entities/run-history/index"
import { decodeShowJson } from "../../packages/run/src/features/seeing-runs/index"

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const compiledOrc = join(repoRoot, "packages/run/dist/orc")
const bundledOrc = [process.execPath, join(repoRoot, "packages/run/dist/bin.js")]
const compileTimeout = 300_000

interface Ran {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const run = async (command: ReadonlyArray<string>, env: Record<string, string | undefined>, cwd: string): Promise<Ran> => {
  const proc = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd, env: { ...process.env, ...env } })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}

const quotaScript = "console.log(JSON.stringify({ schema: \"orc.quota.v1\", accounts: [{ name: \"main\", remainingPercent: 50 }] }))"

const piScript = "process.exit(Bun.spawnSync([...JSON.parse(process.env.ORC_CHAT_ORC ?? \"[]\"), \"--version\"], { stdout: \"inherit\", stderr: \"inherit\" }).exitCode)"

const piExec = "exec '" + process.execPath + "' -e '" + piScript + "'"

const fakePi = ["#!/bin/sh", "printf 'ORC_CHAT_ORC=%s\\n' \"$ORC_CHAT_ORC\"", piExec, ""].join("\n")

// ORC_CHAT_ORC names each build's own path, so the pi that compares builds does not print it.
const quietPi = ["#!/bin/sh", piExec, ""].join("\n")

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

interface Fixture {
  readonly dir: string
  readonly env: Record<string, string>
}

const withFixture = async (body: (fixture: Fixture) => Promise<void>, pi: string = fakePi): Promise<void> => {
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
    await writeFile(join(bin, "pi"), pi)
    await chmod(join(bin, "pi"), 0o755)
    await body({ dir, env: { ORC_HOME: home, PATH: bin + ":" + (process.env.PATH ?? "") } })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const pythonScript = "#!/bin/sh\nprintf '<%s>\\n' \"$@\"\n"

const runPythonStandin = (standin: string, { dir, env }: Fixture): Promise<Ran> =>
  run([standin, "-c", "print(1)", "a b", ""], { ...env, HEAVY_QUEUE_UNREACHABLE: "1" }, dir)

const pythonStandinResult = async (orc: string, fixture: Fixture): Promise<Ran> => {
  const { dir, env } = fixture
  await writeFile(join(dir, "bin", "python3"), pythonScript, { mode: 0o755 })
  const setup = await run([orc, "heavy", "path"], { ...env, HEAVY_QUEUE_BYPASS: "fixture" }, dir)
  expect(setup.exitCode).toBe(0)
  return runPythonStandin(join(setup.stdout.trim(), "python3"), fixture)
}

const expectPythonResult = (result: Ran): void => {
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe("<-c>\n<print(1)>\n<a b>\n<>\n")
}

const expectIsolatedResult = (result: Ran, preloaded: boolean): void => {
  expect(result).toEqual({ exitCode: 0, stdout: "absent\nabsent\nabsent\nkept\n", stderr: "" })
  expect(preloaded).toBe(false)
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
  test("the python assertion rejects a launcher that drops the first tool argument by omitting its own path", async () => {
    await compileOrc()
    await withFixture(async ({ dir, env }) => {
      const real = join(dir, "bin", "python3")
      const standin = join(dir, "wrong-python3")
      await writeFile(real, pythonScript, { mode: 0o755 })
      await writeFile(standin, '#!/bin/sh\nexec "$ORC_COMPILED_FIXTURE" "$ORC_STANDIN_SETTINGS" "$@"\n', { mode: 0o755 })
      const result = await runPythonStandin(standin, {
        dir,
        env: {
          ...env,
          ORC_COMPILED_FIXTURE: compiledOrc,
          ORC_STANDIN_SETTINGS: JSON.stringify({
            tool: "python3", commands: [], home: env.ORC_HOME, group: "heavy", wrap: "", real, through: null, timing: null
          })
        }
      })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(() => expectPythonResult(result)).toThrow()
    })
  }, compileTimeout)

  test("a generated python stand-in passes each argument instead of treating its settings as a command", async () => {
    await compileOrc()
    await withFixture(async (fixture) => {
      expectPythonResult(await pythonStandinResult(compiledOrc, fixture))
    })
  }, compileTimeout)

  test("a compiled stand-in preserves inherited environment without loading caller dotenv files or Bun preloads", async () => {
    await compileOrc()
    await withFixture(async ({ dir, env }) => {
      await writeFile(join(dir, "bin", "python3"), [
        "#!/bin/sh",
        'printf "%s\\n" "${ORC_COMPILED_DOTENV-absent}" "${ORC_COMPILED_LOCAL-absent}" "${ORC_COMPILED_DEVELOPMENT-absent}" "$ORC_COMPILED_INHERITED"',
        ""
      ].join("\n"), { mode: 0o755 })
      const setup = await run([compiledOrc, "heavy", "path"], { ...env, HEAVY_QUEUE_BYPASS: "fixture" }, dir)
      expect(setup.exitCode).toBe(0)
      await Promise.all([
        writeFile(join(dir, ".env"), "ORC_COMPILED_DOTENV=dotenv\n"),
        writeFile(join(dir, ".env.local"), "ORC_COMPILED_LOCAL=local\n"),
        writeFile(join(dir, ".env.development"), "ORC_COMPILED_DEVELOPMENT=development\n"),
        writeFile(join(dir, "bunfig.toml"), 'preload = ["./preload.ts"]\n'),
        writeFile(join(dir, "preload.ts"), 'import { writeFileSync } from "node:fs"\nwriteFileSync("preloaded", "ran")\nconsole.log("caller preload ran")\n')
      ])
      const helperEnv = {
        ...env,
        HEAVY_QUEUE_UNREACHABLE: "1",
        NODE_ENV: "development",
        ORC_COMPILED_DOTENV: undefined,
        ORC_COMPILED_LOCAL: undefined,
        ORC_COMPILED_DEVELOPMENT: undefined,
        ORC_COMPILED_INHERITED: "kept",
        ORC_COMPILED_REAL: join(dir, "bin", "python3")
      }
      const contaminated = await run([
        process.execPath, "-e",
        'process.exit(Bun.spawnSync([process.env.ORC_COMPILED_REAL ?? ""], { stdout: "inherit", stderr: "inherit" }).exitCode)'
      ], helperEnv, dir)
      expect(contaminated.exitCode).toBe(0)
      const preloaded = await exists(join(dir, "preloaded"))
      expect(() => expectIsolatedResult(contaminated, preloaded)).toThrow()
      await rm(join(dir, "preloaded"), { force: true })

      const result = await run([join(setup.stdout.trim(), "python3"), "--version"], helperEnv, dir)
      expectIsolatedResult(result, await exists(join(dir, "preloaded")))
    })
  }, compileTimeout)

  test("compiled helper words reach the waiter and CI guards instead of the CLI usage error", async () => {
    await compileOrc()
    await withFixture(async ({ dir, env }) => {
      const waiter = await run([compiledOrc, "orc-heavy-wait", String(process.pid), "/bin/sh", "-c", 'printf "%s" "$1"', "sh", "a b"], env, dir)
      expect(waiter.exitCode).toBe(0)
      expect(waiter.stdout).toBe("a b")

      const ciOnly = await run([compiledOrc, "orc-ci-only", "pi", join(dir, "absent"), "-c", "echo ok"], env, dir)
      expect(ciOnly.exitCode).toBe(0)
      expect(ciOnly.stdout).toBe(join(dir, "bin", "pi"))

      const ciPath = await run([compiledOrc, "orc-ci-only-path", "./node_modules/.bin/vitest run"], { ...env, HEAVY_TESTS_CI_ONLY: "1" }, dir)
      expect(ciPath.exitCode).toBe(1)
      expect(ciPath.stderr).toContain("repository tests run only in GitHub CI")
    })
  }, compileTimeout)

  test("bun run compile builds one bytecode file that answers help, beat, score, show, chat's self command and reads its embedded agent file", async () => {
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

  test("the compiled file gives the same exit code and output as the bundle for help, beat, show and chat", async () => {
    await compileOrc()
    await withFixture(async ({ dir, env }) => {
      await seedRun(env.ORC_HOME)
      const both = async (args: ReadonlyArray<string>) => ({
        bundle: await run([...bundledOrc, ...args], env, dir),
        compiled: await run([compiledOrc, ...args], env, dir)
      })

      const help = await both(["--help"])
      expect(help.compiled).toEqual(help.bundle)

      const beat = await both(["beat", "--json"])
      expect(beat.bundle.exitCode).toBe(0)
      expect(unstamped(beat.compiled)).toEqual(unstamped(beat.bundle))

      const show = await both(["show", "compiled-1", "--json"])
      expect(show.bundle.exitCode).toBe(0)
      expect(show.compiled).toEqual(show.bundle)

      const chat = await both(["chat"])
      expect(chat.bundle.exitCode).toBe(0)
      expect(chat.compiled).toEqual(chat.bundle)
    }, quietPi)
  }, compileTimeout)
})
