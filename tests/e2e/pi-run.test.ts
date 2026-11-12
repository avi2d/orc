import { describe, expect, test } from "bun:test"
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { hostExec } from "../../packages/run/src/shared/sandbox/agent-exec"
import type { AgentFile } from "../../packages/run/src/entities/agent/index"
import { type PiRun, runPi } from "../../packages/run/src/entities/agent/index"

const agent: AgentFile = { kind: "implementer", model: "acme/coder", thinking: "high", tools: ["read", "bash"], body: "", path: "a.md", source: "bundled" }

const header = JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-11-07T07:41:13.123Z", cwd: "/c" })
const reply = (text: string): string => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } })
const toolStart = JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "bun run test" } })
const toolEnd = JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false })

const bashCall = (id: string, command: string, failed: boolean): ReadonlyArray<string> => [
  JSON.stringify({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command } }),
  JSON.stringify({ type: "tool_execution_end", toolCallId: id, toolName: "bash", isError: failed })
]

const failures = (command: string, count: number, from: number): ReadonlyArray<string> =>
  Array.from({ length: count }, (_, index) => bashCall("f" + (from + index).toString(), command, true)).flat()

const quoted = (line: string): string => "'" + line.replace(/'/g, "'\\''") + "'"

// sh's echo turns the \\n inside a JSON string into a real newline, which splits the event in two.
const emit = (line: string): string => "printf '%s\\n' " + quoted(line)

const exists = (file: string): Promise<boolean> => access(file).then(() => true, () => false)

interface Fixture {
  readonly dir: string
  readonly sessionDir: string
  readonly logFile: string
  readonly marker: string
  readonly failingFile: string
}

const withFakePi = async (body: (fixture: Fixture) => ReadonlyArray<string>, use: (fixture: Fixture) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-pi-run-"))
  try {
    const fixture = { dir, sessionDir: join(dir, "sessions", "host"), logFile: join(dir, "agent.log"), marker: join(dir, "session-stored"), failingFile: join(dir, "failing.json") }
    await mkdir(join(dir, "bin"))
    await mkdir(fixture.sessionDir, { recursive: true })
    await writeFile(join(dir, "bin", "pi"), ["#!/bin/sh", "printf '%s\\n' \"$@\" > \"" + join(dir, "argv") + "\"", "cat > \"" + join(dir, "stdin") + "\"", ...body(fixture)].join("\n") + "\n")
    await chmod(join(dir, "bin", "pi"), 0o755)
    await use(fixture)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const run = (fixture: Fixture, pacing: { readonly tickMillis: number; readonly idleMillis: number; readonly minuteMillis?: number }, stored: Array<string>): Promise<PiRun> =>
  Effect.runPromise(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const exec = hostExec(fixture.dir, { PATH: join(fixture.dir, "bin") + ":" + (Bun.env.PATH ?? ""), HOME: fixture.dir }, {})
    return yield* runPi(spawner, fs, path, exec, {
      agent, prompt: "Do the task.", instructions: null, sessionDir: fixture.sessionDir, resumeSession: null, logFile: fixture.logFile, failingFile: fixture.failingFile,
      onSession: (file) => Effect.promise(async () => {
        stored.push(file)
        await writeFile(fixture.marker, file)
      })
    }, pacing)
  }).pipe(Effect.provide(BunServices.layer)))

describe("runPi", () => {
  test("keeps pi running through a tool that prints nothing for longer than the idle limit", async () => {
    await withFakePi((fixture) => [
      emit(header),
      emit(toolStart),
      "sleep 3",
      emit(toolEnd),
      emit(reply("First reply.")),
      emit(reply("Committed.\nORC_COMPLETE")),
      "echo '{}' > \"" + join(fixture.sessionDir, "2026-11-07T07-41-13-123Z_s1.jsonl") + "\""
    ], async (fixture) => {
      const stored: Array<string> = []
      const result = await run(fixture, { tickMillis: 50, idleMillis: 2_000 }, stored)
      expect(result).toEqual({ sessionId: "s1", sessionFile: join(fixture.sessionDir, "2026-11-07T07-41-13-123Z_s1.jsonl"), end: { kind: "exited", exitCode: 0 } })
      const log = await readFile(fixture.logFile, "utf8")
      expect(log).toBe([
        "orc: pi session " + join(fixture.sessionDir, "2026-11-07T07-41-13-123Z_s1.jsonl"),
        "> bun run test",
        "First reply.",
        "Committed.",
        "ORC_COMPLETE",
        ""
      ].join("\n"))
      expect(await readFile(join(fixture.dir, "stdin"), "utf8")).toBe("Do the task.")
      expect((await readFile(join(fixture.dir, "argv"), "utf8")).split("\n")).toContain(fixture.sessionDir)
    })
  }, 20_000)

  test("stores the session file while pi still runs, not only after it exits", async () => {
    await withFakePi((fixture) => [
      emit(header),
      "n=0; while [ ! -f \"" + fixture.marker + "\" ]; do n=$((n + 1)); if [ $n -gt 100 ]; then exit 3; fi; sleep 0.05; done",
      emit(reply("Saw the session stored."))
    ], async (fixture) => {
      const stored: Array<string> = []
      const result = await run(fixture, { tickMillis: 50, idleMillis: 10_000 }, stored)
      expect(result.end).toEqual({ kind: "exited", exitCode: 0 })
      expect(stored).toEqual([join(fixture.sessionDir, "2026-11-07T07-41-13-123Z_s1.jsonl")])
      expect(result.sessionFile).toBeNull()
    })
  }, 20_000)

  test("stops pi that prints nothing with no tool running, instead of waiting for it forever", async () => {
    await withFakePi(() => [
      emit(header),
      "exec sleep 30"
    ], async (fixture) => {
      const started = Date.now()
      const result = await run(fixture, { tickMillis: 50, idleMillis: 300 }, [])
      expect(result.end).toEqual({ kind: "idle", idleSeconds: 0 })
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(await readFile(fixture.logFile, "utf8")).toContain("orc: stopped pi, idle for 0 seconds with no tool running")
    })
  }, 20_000)

  test("stops a quiet pi at the idle limit instead of waiting for the next still-running tick", async () => {
    await withFakePi(() => [
      emit(header),
      "exec sleep 30"
    ], async (fixture) => {
      const started = Date.now()
      const result = await run(fixture, { tickMillis: 60_000, idleMillis: 300 }, [])
      expect(result.end.kind).toBe("idle")
      expect(Date.now() - started).toBeLessThan(10_000)
    })
  }, 20_000)

  test("stops pi at the sixth failure of one command in a row instead of letting it loop on", async () => {
    await withFakePi(() => [
      emit(header),
      ...failures("bun run test", 6, 1).map(emit),
      "exec sleep 30"
    ], async (fixture) => {
      const started = Date.now()
      const result = await run(fixture, { tickMillis: 50, idleMillis: 20_000 }, [])
      expect(result.end).toEqual({ kind: "looping", label: "bun run test" })
      expect(Date.now() - started).toBeLessThan(10_000)
      const log = await readFile(fixture.logFile, "utf8")
      expect(log).toContain("orc: pi failed bun run test 3 times in a row")
      expect(log).toContain("orc: stopped pi, it failed bun run test 6 times in a row")
      expect(await exists(fixture.failingFile)).toBe(false)
    })
  }, 20_000)

  test("marks the third failure in a row while pi runs, and clears the mark once a different command succeeds", async () => {
    const seen = (fixture: Fixture) => join(fixture.dir, "failing-seen")
    const waitFor = (condition: string) => "n=0; while ! " + condition + "; do n=$((n + 1)); if [ $n -gt 100 ]; then exit 3; fi; sleep 0.05; done"
    await withFakePi((fixture) => [
      emit(header),
      ...failures("bun run test", 3, 1).map(emit),
      waitFor("[ -f \"" + fixture.failingFile + "\" ]"),
      "cp \"" + fixture.failingFile + "\" \"" + seen(fixture) + "\"",
      ...bashCall("ok", "bun run lint", false).map(emit),
      waitFor("[ ! -f \"" + fixture.failingFile + "\" ]"),
      emit(reply("Done."))
    ], async (fixture) => {
      const result = await run(fixture, { tickMillis: 50, idleMillis: 20_000 }, [])
      expect(result.end).toEqual({ kind: "exited", exitCode: 0 })
      expect(JSON.parse(await readFile(seen(fixture), "utf8"))).toMatchObject({ label: "bun run test" })
    })
  }, 20_000)

  test("counts a failure of another command as a fresh streak instead of adding it to the last one", async () => {
    await withFakePi(() => [
      emit(header),
      ...failures("bun run test", 5, 1).map(emit),
      ...failures("bun run lint", 1, 6).map(emit),
      ...failures("bun run test", 5, 7).map(emit),
      emit(reply("Done."))
    ], async (fixture) => {
      const result = await run(fixture, { tickMillis: 50, idleMillis: 20_000 }, [])
      expect(result.end).toEqual({ kind: "exited", exitCode: 0 })
      expect(await readFile(fixture.logFile, "utf8")).not.toContain("orc: stopped pi")
    })
  }, 20_000)

  test("logs still running while a tool runs instead of staying silent", async () => {
    await withFakePi((fixture) => [
      emit(header),
      emit(toolStart),
      "sleep 0.6",
      emit(toolEnd),
      emit(reply("Done.")),
      "echo '{}' > \"" + join(fixture.sessionDir, "2026-11-07T07-41-13-123Z_s1.jsonl") + "\""
    ], async (fixture) => {
      const result = await run(fixture, { tickMillis: 20, idleMillis: 5_000, minuteMillis: 100 }, [])
      expect(result.end).toEqual({ kind: "exited", exitCode: 0 })
      expect(await readFile(fixture.logFile, "utf8")).toContain("orc: still running bun run test")
    })
  }, 20_000)
})
