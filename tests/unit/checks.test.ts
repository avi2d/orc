import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import type { AgentFile } from "../../src/agents"
import { buildFixPrompt, checksFileName, maxFixAttempts, readChecksCommands, runChecksRound, type CommandResult } from "../../src/checks"
import { orcCompletionLine } from "../../src/pi"

type Deps = FileSystem.FileSystem | Path.Path

const provide = <A, E>(effect: Effect.Effect<A, E, Deps>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, BunServices.layer))

const parse = (text: string): Promise<{ readonly ok: boolean; readonly right?: unknown }> =>
  provide(readChecksCommands(text, "project.yaml").pipe(
    Effect.map((right) => ({ ok: true as const, right })),
    Effect.catch((left) => Effect.succeed({ ok: false as const, right: String(left) }))
  ))

const fixer: AgentFile = {
  kind: "fixer",
  model: "opencode-go/muse-spark",
  thinking: "high",
  tools: ["read", "bash"],
  body: "Fix the failure.",
  path: "bundled/fixer.md",
  source: "bundled"
}

describe("readChecksCommands", () => {
  test("reads each check name and command in file order", async () => {
    const result = await parse("commands:\n  lint: bun run lint\n  typecheck: bun run typecheck\n")
    expect(result.ok).toBe(true)
    expect(result.right).toEqual([
      { name: "lint", command: "bun run lint" },
      { name: "typecheck", command: "bun run typecheck" }
    ])
  })

  test("refuses a file with no checks mapping, an empty mapping and an unusable entry", async () => {
    for (const text of ["other: 1\n", "commands: {}\n", "commands:\n  lint: 42\n", "commands:\n  '': bun run lint\n"]) {
      expect((await parse(text)).ok).toBe(false)
    }
  })

  test("refuses text no YAML parser reads", async () => {
    expect((await parse("commands: [unclosed\n")).ok).toBe(false)
  })
})

describe("runChecksRound", () => {
  test("writes one evidence file with each command, its output and its pass or fail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-checks-"))
    try {
      const calls: Array<string> = []
      const runCommand = async (command: string): Promise<CommandResult> => {
        calls.push(command)
        return command === "bun run lint"
          ? { stdout: "lint ok", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "type error on line 3", exitCode: 1 }
      }
      const round = await provide(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const outcome = yield* runChecksRound(runCommand, fs, path, dir, 2, [
          { name: "lint", command: "bun run lint" },
          { name: "typecheck", command: "bun run typecheck" }
        ])
        const text = yield* fs.readFileString(outcome.file)
        return { outcome, text }
      }))
      expect(calls).toEqual(["bun run lint", "bun run typecheck"])
      expect(round.outcome.file.endsWith("checks-2.txt")).toBe(true)
      expect(round.outcome.outcomes.map((check) => check.passed)).toEqual([true, false])
      expect(round.text).toContain("check lint: bun run lint")
      expect(round.text).toContain("lint ok")
      expect(round.text).toContain("exit 0: passed")
      expect(round.text).toContain("check typecheck: bun run typecheck")
      expect(round.text).toContain("type error on line 3")
      expect(round.text).toContain("exit 1: failed")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("marks empty output so an empty pass still reads as evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-checks-"))
    try {
      const text = await provide(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const outcome = yield* runChecksRound(async () => ({ stdout: "", stderr: "", exitCode: 0 }), fs, path, dir, 1, [
          { name: "lint", command: "bun run lint" }
        ])
        return yield* fs.readFileString(outcome.file)
      }))
      expect(text).toContain("(no output)")
      expect(text).toContain("exit 0: passed")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a command that throws ends the round with its check named", async () => {
    const failed = await provide(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      return yield* runChecksRound(async () => {
        throw new Error("sandbox blew up")
      }, fs, path, "/nowhere", 1, [{ name: "lint", command: "bun run lint" }]).pipe(
        Effect.map(() => "ran"),
        Effect.catchTag("ChecksError", (cause) => Effect.succeed(cause.message)))
    }))
    expect(failed).toContain("lint")
    expect(failed).toContain("sandbox blew up")
  })
})

describe("checks evidence names", () => {
  test("rounds are numbered from one and fix attempts stop at three", () => {
    expect(checksFileName(1)).toBe("checks-1.txt")
    expect(checksFileName(4)).toBe("checks-4.txt")
    expect(maxFixAttempts).toBe(3)
  })

  test("the fix prompt hands the failed output file and keeps the completion marker", () => {
    const prompt = buildFixPrompt(fixer, "/runs/abc/checks-1.txt")
    expect(prompt).toContain("Fix the failure.")
    expect(prompt).toContain("/runs/abc/checks-1.txt")
    expect(prompt).toContain(orcCompletionLine)
  })
})
