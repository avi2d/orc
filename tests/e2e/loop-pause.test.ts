import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { listRuns, openDatabase, openQuestionsForRun } from "../../packages/run/src/entities/run-history/index"
import { type NoSandboxFixture, runOrc, withNoSandboxFixture, writeScript } from "./no-sandbox-fixture"

const sessionId = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c"

const failingBash = (index: number): ReadonlyArray<string> => [
  JSON.stringify({ type: "tool_execution_start", toolCallId: "t" + index.toString(), toolName: "bash", args: { command: "bun run test" } }),
  JSON.stringify({ type: "tool_execution_end", toolCallId: "t" + index.toString(), toolName: "bash", isError: true })
]

const loopingPi = async (fixture: NoSandboxFixture): Promise<void> => {
  const stream = [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-10-28T10:00:00.000Z", cwd: "/repo" }),
    ...[1, 2, 3, 4, 5, 6].flatMap(failingBash)
  ].join("\n") + "\n"
  await writeFile(join(fixture.fakeBin, "loop-stream.jsonl"), stream)
  await writeScript(join(fixture.fakeBin, "pi"), [
    "if [ \"$1\" = auth ]; then exit 0; fi",
    "if [ \"$1\" = --mode ]; then cat > /dev/null; echo '{\"id\":\"orc-models\",\"type\":\"response\",\"command\":\"get_available_models\",\"success\":true,\"data\":{\"models\":[{\"provider\":\"acme-go\",\"id\":\"coder-1\",\"contextWindow\":262144}]}}'; exit 0; fi",
    "if [ -f \"" + fixture.fakeBin + "/pi-runs\" ]; then echo \"$*\" > \"" + fixture.fakeBin + "/resumed-argv\"; cat > \"" + fixture.fakeBin + "/resumed-prompt\"; echo ran >> \"" + fixture.fakeBin + "/pi-runs\"; exit 1; fi",
    "cat > /dev/null",
    "echo ran >> \"" + fixture.fakeBin + "/pi-runs\"",
    "prev=''; for arg in \"$@\"; do if [ \"$prev\" = --session-dir ]; then session_dir=$arg; fi; prev=$arg; done",
    "mkdir -p \"$session_dir\"",
    "head -n 1 \"" + fixture.fakeBin + "/loop-stream.jsonl\" > \"$session_dir/2026-10-28T10-00-00-000Z_" + sessionId + ".jsonl\"",
    "cat \"" + fixture.fakeBin + "/loop-stream.jsonl\"",
    "exec sleep 60"
  ])
}

const askedInHistory = (fixture: NoSandboxFixture) =>
  Effect.runPromise(Effect.acquireUseRelease(
    openDatabase(fixture.env["ORC_HOME"] ?? ""),
    (db) => Effect.gen(function*() {
      const runs = yield* listRuns(db)
      return yield* openQuestionsForRun(db, runs[0]?.id ?? "")
    }),
    (db) => Effect.sync(() => db.close())
  ).pipe(Effect.provide(BunServices.layer)))

const piRuns = async (fixture: NoSandboxFixture): Promise<number> =>
  (await readFile(join(fixture.fakeBin, "pi-runs"), "utf8")).trim().split("\n").length

const pausedRun = async (fixture: NoSandboxFixture): Promise<{ readonly exitCode: number; readonly stdout: string }> => {
  await loopingPi(fixture)
  return runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], fixture.repo, { ...fixture.env, ORC_ANSWER_WAIT_SECONDS: "0" })
}

describe("orc run with Pi failing one command", () => {
  test("stops Pi at the sixth failure in a row and ends the run unfinished, instead of letting Pi loop on", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const started = Date.now()
      const result = await pausedRun(fixture)
      expect(Date.now() - started).toBeLessThan(40_000)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain("orc paused Pi after it failed bun run test 6 times in a row, and no answer to continue or stop came in time.")
      expect(await piRuns(fixture)).toBe(1)
      expect(await askedInHistory(fixture)).toEqual([expect.objectContaining({ id: "looping", text: expect.stringContaining("Answer continue") })])
    })
  }, 60_000)

  test("a stop answer ends the resumed run before Pi runs again, instead of resuming the loop", async () => {
    await withNoSandboxFixture(async (fixture) => {
      await pausedRun(fixture)
      const stopped = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none", "--answer", "looping=stop"], fixture.repo, fixture.env)
      expect(stopped.exitCode).not.toBe(0)
      expect(stopped.stdout).toContain("The captain stopped the run when it paused on a failing command, answering: stop")
      expect(await piRuns(fixture)).toBe(1)
    })
  }, 60_000)

  test("a continue answer resumes the same Pi session with the captain's guidance, instead of a fresh session", async () => {
    await withNoSandboxFixture(async (fixture) => {
      await pausedRun(fixture)
      const resumed = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none", "--answer", "looping=continue, run one test file at a time"], fixture.repo, { ...fixture.env, ORC_ANSWER_WAIT_SECONDS: "0" })
      expect(resumed.exitCode).not.toBe(0)
      expect(await piRuns(fixture)).toBe(2)
      expect(await readFile(join(fixture.fakeBin, "resumed-argv"), "utf8")).toContain(sessionId)
      expect(await readFile(join(fixture.fakeBin, "resumed-prompt"), "utf8")).toContain("the captain answered: continue, run one test file at a time")
    })
  }, 30_000)
})
