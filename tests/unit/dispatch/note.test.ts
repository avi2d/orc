import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem } from "effect"
import { parseDispatchArgs } from "../../../packages/run/src/app/dispatch-args"
import { addTask, appendNote, claimTask, closeStartedTask, readNotes, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { noteTask } from "../../../packages/run/src/features/task-thread/index"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-note-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("orc backlog note", () => {
  test("parses the task id and joins the words", () => {
    expect(parseDispatchArgs("backlog", ["note", "orc-1", "check", "the", "logs"])).toEqual({ kind: "NoteTask", id: "orc-1", words: "check the logs" })
    expect(parseDispatchArgs("backlog", ["note", "orc-1"])).toEqual({ kind: "UsageError", detail: "orc backlog note takes a task id and the note's words" })
    expect(parseDispatchArgs("backlog", ["note", "nope"])).toEqual({ kind: "UsageError", detail: "orc backlog note takes a task id, got \"nope\"" })
  })

  test("two concurrent writers leave two whole note lines", () =>
    withBacklog(async (root) => {
      const long = "x".repeat(200_000)
      await run(Effect.all([
        appendNote(root, "orc-1", { at: "2026-10-27T10:00:00.000Z", who: "captain", text: "a" + long }),
        appendNote(root, "orc-1", { at: "2026-10-27T10:00:01.000Z", who: "decider", text: "b" + long })
      ], { concurrency: "unbounded" }))
      const lines = (await readFile(join(root, "notes", "orc-1.jsonl"), "utf8")).split("\n")
      expect(lines).toHaveLength(3)
      expect(lines[2]).toBe("")
      const notes = await run(readNotes(root, "orc-1"))
      expect(notes.map((note) => note.who).sort()).toEqual(["captain", "decider"])
      expect(notes.map((note) => note.text.length)).toEqual([long.length + 1, long.length + 1])
    }))

  test("a short append write fails instead of writing the rest", () =>
    withBacklog(async (root) => {
      const failed = await run(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const short: FileSystem.FileSystem = {
          ...fs,
          open: (path, options) =>
            Effect.map(
              fs.open(path, options),
              (handle) => ({ ...handle, write: (buffer: Uint8Array) => handle.write(buffer.subarray(0, 1)) })
            )
        }
        return yield* appendNote(root, "orc-1", { at: "2026-10-27T10:00:00.000Z", who: "captain", text: "hello" }).pipe(
          Effect.provideService(FileSystem.FileSystem, short),
          Effect.flip
        )
      }))
      expect(failed.detail).toContain("wrote 1 of")
      expect(await readFile(join(root, "notes", "orc-1.jsonl"))).toHaveLength(1)
    }))

  test("refuses a task id the backlog does not hold", () =>
    withBacklog(async (root) => {
      await run(addTask(root, spec))
      const refused = await run(noteTask(root, "orc-9", "hello", "2026-10-27T10:00:00.000Z").pipe(Effect.flip))
      expect(refused.detail).toBe("the backlog holds no orc-9")
      expect(await run(readNotes(root, "orc-9"))).toEqual([])
    }))

  test("a closed task takes a note", () =>
    withBacklog(async (root) => {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
      await run(closeStartedTask(root, record.spec.id, "done", "", { pr: null, report: null }, "2026-10-27T11:00:00.000Z"))
      expect(await run(noteTask(root, "orc-1", "merged by hand", "2026-10-27T12:00:00.000Z"))).toBe("noted on orc-1")
      expect(await run(readNotes(root, "orc-1"))).toEqual([{ at: "2026-10-27T12:00:00.000Z", who: "captain", text: "merged by hand" }])
    }))
})
