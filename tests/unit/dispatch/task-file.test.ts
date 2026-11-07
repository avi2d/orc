import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Result } from "effect"
import { parseTaskFile, TaskFileError, type TaskRecord } from "../../../packages/run/src/dispatch/task-record"
import { renderTaskFile } from "../../../packages/run/src/dispatch/task-record-render"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, dependsOn: [], created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

const started = { at: "2026-10-27T10:02:00.000Z", log: "/logs/task-1.log" }

const frontmatter = (kindLine: string): string =>
  "---\nid: task-1\ntitle: Map the parser\nproject: orc\n" + kindLine + "machine: null\ndepends_on: []\ncreated: 2026-10-27T10:00:00.000Z\n---\n# Map the parser\n"

describe("task files", () => {
  test("a hand-written task file reads as a new task with its body intact", async () => {
    const text = "---\nid: task-7\ntitle: Fix the thing\nproject: orc\nmachine: mac\ndepends_on: [task-3]\ncreated: 2026-10-27T10:00:00.000Z\n---\n# Fix the thing\n\nDo it.\n"
    const record = await run(parseTaskFile("task-7.md", "new", text))
    expect(record).toEqual({
      spec: { id: "task-7", title: "Fix the thing", project: "orc", kind: "ship", internal: false, machine: "mac", dependsOn: ["task-3"], created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n\nDo it.\n" },
      hold: null,
      parked: null,
      state: { kind: "new" }
    })
  })
  test("a body holding a --- line survives a write and a read instead of being cut there", async () => {
    const record: TaskRecord = {
      spec: { ...spec, id: "task-2", body: "Before\n---\nAfter\n" },
      hold: null,
      parked: null,
      state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: "/home/captain/.orc/backlog/logs/task-2.log" } }
    }
    expect(await run(parseTaskFile("task-2.md", "taken", renderTaskFile(record)))).toEqual(record)
  })
  test("a copied file whose frontmatter id is not its own stem is refused instead of read as that task", async () => {
    const text = "---\nid: task-3\ntitle: Fix the thing\nproject: orc\nmachine: null\ndepends_on: []\ncreated: 2026-10-27T10:00:00.000Z\n---\n# Fix the thing\n"
    const result = await run(Effect.result(parseTaskFile("new/task-9.md", "new", text)))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(TaskFileError)
      expect(result.failure.file).toContain("task-9.md")
    }
  })
  test("a file with no frontmatter is refused instead of read as an empty task", async () => {
    const result = await run(Effect.result(parseTaskFile("task-1.md", "new", "# Just a title\n")))
    expect(Result.isFailure(result)).toBe(true)
  })
  test("a task file with no kind line reads as ship instead of being refused", async () => {
    expect((await run(parseTaskFile("task-1.md", "new", frontmatter("")))).spec.kind).toBe("ship")
  })
  test("a task file with an unknown kind is refused with the kinds it may take instead of read as ship", async () => {
    const result = await run(Effect.result(parseTaskFile("task-1.md", "new", frontmatter("kind: deploy\n"))))
    expect(Result.isFailure(result) ? result.failure.detail : null).toBe("the kind deploy is not ship, scout or task")
  })
  test("an internal ship task keeps its mark through a write and a read instead of reading as unmarked", async () => {
    const record: TaskRecord = { spec: { ...spec, id: "task-3", internal: true }, hold: null, parked: null, state: { kind: "new" } }
    const text = renderTaskFile(record)
    expect(text).toContain("internal: true\n")
    expect(await run(parseTaskFile("task-3.md", "new", text))).toEqual(record)
  })
  test("a task file with no internal line reads as unmarked instead of being refused", async () => {
    expect((await run(parseTaskFile("task-1.md", "new", frontmatter("")))).spec.internal).toBe(false)
  })
  test("a closed scout keeps its kind and report through a write and a read instead of dropping them", async () => {
    const record: TaskRecord = {
      spec: { ...spec, id: "task-2", kind: "scout" },
      hold: null,
      parked: null,
      state: {
        kind: "closed",
        claim,
        closing: { outcome: "done", started, reason: "the run wrote its report", pr: null, report: "/runs/run-1/agent-report.md" },
        closedAt: "2026-10-27T11:00:00.000Z",
        postedAt: null
      }
    }
    expect(await run(parseTaskFile("task-2.md", "closed", renderTaskFile(record)))).toEqual(record)
  })
})
