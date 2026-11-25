import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { type ChecksCommand, type ChecksError, runChecksRound } from "../../packages/run/src/features/running-a-task/checks"
import { type CommandResult, hostExec, streamShellInAgent } from "../../packages/run/src/shared/sandbox/agent-exec"

type Runner = (command: string, onOutput: (text: string) => Effect.Effect<void, ChecksError>) => Effect.Effect<CommandResult, { readonly message: string }>

// A shared afterEach could delete a folder while a round that outlived its test still writes there, so each test removes only its own folder once its round settles.
const inScratch = async <A>(body: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-checks-stream-"))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const readOrEmpty = (file: string): Promise<string> => readFile(file, "utf8").catch(() => "")

const waitForText = async (file: string, ready: (text: string) => boolean, deadline: number): Promise<string> => {
  let text = await readOrEmpty(file)
  while (!ready(text) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    text = await readOrEmpty(file)
  }
  return text
}

const runRound = (dir: string, runner: Runner, commands: ReadonlyArray<ChecksCommand>): Promise<string> =>
  Effect.runPromise(Effect.provide(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const round = yield* runChecksRound(runner, fs, path, dir, 1, commands)
    return yield* fs.readFileString(round.file)
  }), BunServices.layer))

const chunked = (chunks: ReadonlyArray<string>, result: CommandResult): Runner => (_command, onOutput) =>
  Effect.gen(function*() {
    for (const chunk of chunks) {
      yield* onOutput(chunk)
    }
    return result
  })

describe("runChecksRound streams each check into the evidence file", () => {
  test("rejects a file that is still empty after the check printed its first line and before it exits", () =>
    inScratch(async (dir) => {
      const file = join(dir, "checks-1.txt")
      let midway = ""
      const runner: Runner = (_command, onOutput) =>
        Effect.gen(function*() {
          yield* onOutput("first\n")
          midway = yield* Effect.promise(() => readFile(file, "utf8"))
          yield* onOutput("second\n")
          return { stdout: "first\nsecond\n", stderr: "", exitCode: 0 }
        })
      await runRound(dir, runner, [{ name: "slow", command: "slow" }])
      expect(midway).toBe("check slow: slow\nfirst")
    }))

  test("rejects a real shell check whose first line waits for the command to exit", () =>
    inScratch(async (dir) => {
      const file = join(dir, "checks-1.txt")
      const release = join(dir, "release")
      const quoted = "'" + release.replace(/'/g, "'\\''") + "'"
      const exec = hostExec(dir, process.env, {})
      const runner: Runner = (command, onOutput) =>
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          return yield* streamShellInAgent(spawner, exec, command, onOutput)
        }).pipe(Effect.provide(BunServices.layer))
      const command = "echo first; i=0; while [ ! -e " + quoted + " ]; do sleep 0.05; i=$((i + 1)); if [ \"$i\" -gt 200 ]; then exit 1; fi; done; echo second"
      const header = "check slow: " + command
      const done = runRound(dir, runner, [{ name: "slow", command }])
      let midway = ""
      try {
        midway = await waitForText(file, (text) => text !== header && text.startsWith(header), Date.now() + 10000)
      } finally {
        await writeFile(release, "")
      }
      const text = await done
      expect(midway).toBe(header + "\nfirst")
      expect(text).toBe(header + "\nfirst\nsecond\nexit 0: passed\n")
    }), 20000)

  test("rejects a finished file that differs from the whole-output format for a passing, a failing and a silent check", () =>
    inScratch(async (dir) => {
      const outputs: Record<string, { readonly chunks: ReadonlyArray<string>; readonly result: CommandResult }> = {
        lint: { chunks: ["\n  lint", " ok\n", "\n"], result: { stdout: "\n  lint ok\n\n", stderr: "", exitCode: 0 } },
        typecheck: { chunks: ["type error", "\n\n", "on line 3\n"], result: { stdout: "", stderr: "type error\n\non line 3\n", exitCode: 2 } },
        quiet: { chunks: ["\n", "  "], result: { stdout: "\n  ", stderr: "", exitCode: 0 } }
      }
      const runner: Runner = (command, onOutput) => {
        const output = outputs[command] ?? { chunks: [], result: { stdout: "", stderr: "", exitCode: 0 } }
        return chunked(output.chunks, output.result)(command, onOutput)
      }
      const text = await runRound(dir, runner, [
        { name: "lint", command: "lint" },
        { name: "typecheck", command: "typecheck" },
        { name: "quiet", command: "quiet" }
      ])
      expect(text).toBe([
        "check lint: lint\nlint ok\nexit 0: passed",
        "check typecheck: typecheck\ntype error\n\non line 3\nexit 2: failed",
        "check quiet: quiet\n(no output)\nexit 0: passed"
      ].join("\n\n") + "\n")
    }))

  test("rejects a finished file that interleaves stdout and stderr in arrival order", () =>
    inScratch(async (dir) => {
      const runner: Runner = (_command, onOutput) =>
        Effect.gen(function*() {
          yield* onOutput("err\n")
          yield* onOutput("out\n")
          return { stdout: "out\n", stderr: "err\n", exitCode: 0 }
        })
      const text = await runRound(dir, runner, [{ name: "mix", command: "mix" }])
      expect(text).toBe("check mix: mix\nout\nerr\nexit 0: passed\n")
    }))

  test("records the actual output range and time instead of treating command output as check boundaries", () =>
    inScratch(async (dir) => {
      const output = "é 🚀\nexit 0: passed\n\ncheck fake: this is output\nactual failure"
      const header = "check lint: lint\n"
      const runner: Runner = () => TestClock.adjust("1500 millis").pipe(Effect.as({ stdout: output, stderr: "", exitCode: 1 }))
      const round = await Effect.runPromise(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        return yield* runChecksRound(runner, fs, path, dir, 1, [{ name: "lint", command: "lint" }])
      }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, TestClock.layer()))))
      const raw = await readFile(round.file, "utf8")
      expect(raw).toBe(header + output + "\nexit 1: failed\n")
      expect(await readFile(round.file + ".index.json", "utf8")).toBe(JSON.stringify({
        checks: [{ name: "lint", outputStart: header.length, result: { outputEnd: header.length + output.length, passed: false, seconds: 1.5 } }]
      }))
    }))

  test("rejects a file that loses the output of a runner that returns it whole without streaming", () =>
    inScratch(async (dir) => {
      const runner: Runner = () => Effect.succeed({ stdout: "  lint ok\n", stderr: "", exitCode: 0 })
      const text = await runRound(dir, runner, [{ name: "lint", command: "lint" }])
      expect(text).toBe("check lint: lint\nlint ok\nexit 0: passed\n")
    }))
})
