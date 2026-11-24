import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { driveNoMistakes, type NoMistakesRunner } from "../../packages/run/src/entities/review-gate/no-mistakes"

const passed = [
  "id: \"01RUN\"",
  "branch: orc/orc-1",
  "status: completed",
  "findings: none",
  "outcome: passed"
].join("\n")

const startedWith = async (writeTask: boolean): Promise<{ readonly intentFile: string; readonly intent: string; readonly taskFile: string; readonly gate: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-review-intent-"))
  try {
    const taskFile = join(dir, "task.md")
    if (writeTask) {
      await writeFile(taskFile, "# Retry the upload\nRetry a failed upload twice, then give up.\n")
    }
    const started: Array<string> = []
    const runner: NoMistakesRunner = {
      start: (intentFile) => {
        started.push(intentFile)
        return Effect.succeed({ stdout: passed, stderr: "", exitCode: 0 })
      },
      reattach: Effect.succeed({ stdout: passed, stderr: "", exitCode: 0 }),
      respond: () => Effect.die("no gate is parked"),
      answer: () => Effect.die("no question is open"),
      status: () => Effect.succeed({ stdout: passed, stderr: "", exitCode: 0 }),
      logs: () => Effect.succeed({ stdout: "findings: none", stderr: "", exitCode: 0 })
    }
    await Effect.runPromise(driveNoMistakes({ runner, taskFile, runDir: dir }).pipe(Effect.provide(BunServices.layer)))
    const intentFile = started.at(0) ?? ""
    const intent = writeTask ? await readFile(intentFile, "utf8") : ""
    return { intentFile, intent, taskFile, gate: await readFile(join(dir, "gate.log"), "utf8") }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("the intent orc starts the review with", () => {
  test("holds the task and the rule that each review question names a Recommended: option, instead of letting a question offer two remedies with no recommendation", async () => {
    const { intentFile, intent, taskFile } = await startedWith(true)
    expect(intentFile).not.toBe(taskFile)
    expect(intent.startsWith("# Retry the upload\nRetry a failed upload twice, then give up.\n\n")).toBe(true)
    expect(intent).toContain("Every question the review asks names one recommended option.")
    expect(intent).toContain("Put that option on its own line that starts with \"Recommended:\"")
  })

  test("falls back to the bare task file and says so in gate.log when orc cannot write it, instead of dropping the Recommended: rule silently", async () => {
    const { intentFile, taskFile, gate } = await startedWith(false)
    expect(intentFile).toBe(taskFile)
    expect(gate).toContain("without the Recommended: rule")
  })
})
