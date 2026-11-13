import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { type ChecksCommand, type ChecksError, runChecksRound } from "../../packages/run/src/features/running-a-task/checks"
import { type CommandResult, hostExec, streamShellInAgent } from "../../packages/run/src/shared/sandbox/agent-exec"

type Runner = (command: string, onOutput: (text: string) => Effect.Effect<void, ChecksError>) => Effect.Effect<CommandResult, { readonly message: string }>

const dirs: Array<string> = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-checks-stream-"))
  dirs.push(dir)
  return dir
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
  test("rejects a file that is still empty after the check printed its first line and before it exits", async () => {
    const dir = await scratch()
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
  })

  test("rejects a real shell check whose first line waits for the command to exit", async () => {
    const dir = await scratch()
    const file = join(dir, "checks-1.txt")
    const exec = hostExec(dir, process.env, {})
    let midway = ""
    const runner: Runner = (command, onOutput) =>
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        return yield* streamShellInAgent(spawner, exec, command, (text) =>
          onOutput(text).pipe(Effect.andThen(Effect.promise(async () => {
            midway = midway === "" ? await readFile(file, "utf8") : midway
          }))))
      }).pipe(Effect.provide(BunServices.layer))
    const text = await runRound(dir, runner, [{ name: "slow", command: "echo first; sleep 1; echo second" }])
    expect(midway).toBe("check slow: echo first; sleep 1; echo second\nfirst")
    expect(text).toBe("check slow: echo first; sleep 1; echo second\nfirst\nsecond\nexit 0: passed\n")
  })

  test("rejects a finished file that differs from the whole-output format for a passing, a failing and a silent check", async () => {
    const dir = await scratch()
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
  })

  test("rejects a file that loses the output of a runner that returns it whole without streaming", async () => {
    const dir = await scratch()
    const runner: Runner = () => Effect.succeed({ stdout: "  lint ok\n", stderr: "", exitCode: 0 })
    const text = await runRound(dir, runner, [{ name: "lint", command: "lint" }])
    expect(text).toBe("check lint: lint\nlint ok\nexit 0: passed\n")
  })
})
