import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { addTask, answerWait, claimTask, listTasks, renderTaskFile, writeTaken, type TaskRecord } from "../../../packages/run/src/entities/backlog/index"
import { answerTask, askStartedTask, handAnswersToResume, parkStartedTask } from "../../../packages/run/src/entities/parked-runs/index"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:09:00.000Z" }

const asked = "2026-10-27T10:04:00.000Z"
const r2 = { id: "r2", text: "Keep the old flag?" }
const lint = "no-mistakes stopped at the lint gate"

const withResumed = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-repeat-"))
  try {
    const added = await run(addTask(root, spec))
    const answered = { ...r2, asked, blocks: true, answer: { words: "Keep it", at: "2026-10-27T10:05:00.000Z", relayedTo: null } }
    await writeFile(join(root, "new", "orc-1.md"), renderTaskFile({ ...added, parked: { branch: "orc/orc-1", origin: { machine: "mac", run: "run-1" }, questions: [answered] } }))
    await run(claimTask(root, "orc-1"))
    await run(writeTaken(root, { ...handAnswersToResume(await current(root)), state: { kind: "started", claim, started: { at: "2026-10-27T10:10:00.000Z", log: root + "/logs/orc-1.log" } } }))
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const current = async (root: string): Promise<TaskRecord> => {
  const task = (await run(listTasks(root))).at(0)
  if (task === undefined) {
    throw new Error("the backlog holds no task")
  }
  return task
}

describe("a resumed run that parks again", () => {
  test("parking on only the answers handed to it holds the task with the run's end reason instead of resuming it on the next beat", async () => {
    await withResumed(async (root) => {
      const parked = await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked }], "2026-10-27T10:35:00.000Z", "run-2", lint))
      expect(parked.hold?.reason).toContain("run-2")
      expect(parked.hold?.reason).toContain(lint)
      expect(answerWait(parked, () => false)).toStartWith("held for the captain: ")
    })
  })
  test("an answer given during the run resumes it instead of holding it", async () => {
    await withResumed(async (root) => {
      const again = "2026-10-27T10:15:00.000Z"
      await run(askStartedTask(root, "orc-1", { asked: again, questions: [r2] }))
      await run(answerTask(root, "orc-1", "r2=Drop it", "2026-10-27T10:20:00.000Z"))
      const parked = await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked: again }], "2026-10-27T10:35:00.000Z", "run-2", lint))
      expect(parked.hold).toBeNull()
      expect(answerWait(parked, () => false)).toBeNull()
    })
  })
  test("a new question parks it for the captain instead of holding it", async () => {
    await withResumed(async (root) => {
      const parked = await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ id: "r3", text: "Drop the old docs?", asked: "2026-10-27T10:30:00.000Z" }], "2026-10-27T10:35:00.000Z", "run-2", lint))
      expect(parked.hold).toBeNull()
      expect(answerWait(parked, () => false)).toBe("parked on orc/orc-1 for the captain's answer to r3")
    })
  })
  test("the captain's answer releases the hold instead of refusing a parked task with no open question", async () => {
    await withResumed(async (root) => {
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked }], "2026-10-27T10:35:00.000Z", "run-2", lint))
      expect(await run(answerTask(root, "orc-1", "fix the lint finding first", "2026-10-27T10:40:00.000Z"))).toMatchObject({ kind: "hold" })
      expect(answerWait(await current(root), () => false)).toBeNull()
    })
  })
})
