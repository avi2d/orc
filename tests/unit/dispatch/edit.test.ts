import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { addTask, claimTask, findTask, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { edit, editTask } from "../../../packages/run/src/features/backlog-planning/index"
import { holdTask } from "../../../packages/run/src/features/backlog-planning/backlog-hold"
import { answerTask } from "../../../packages/run/src/entities/parked-runs/index"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0, created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const newText = { title: "Fix the thing in the folder map", body: "# Fix the thing in the folder map\n\nRead the new paths.\n" }

const withRoot = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-edit-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("orc backlog edit", () => {
  test("an edit keeps the hold, its history and the dependencies instead of dropping them with the old text", async () => {
    await withRoot(async (root) => {
      await run(addTask(root, spec))
      await run(addTask(root, { ...spec, machine: "linux", dependsOn: ["orc-1"] }))
      await run(holdTask(root, "orc-2", { reason: "Choose the format", until: null, questions: ["Which format?"] }))
      await run(answerTask(root, "orc-2", "question-1=JSON", "2026-10-28T10:00:00.000Z"))
      await run(holdTask(root, "orc-2", { reason: "Wait for the merge", until: "2026-12-01", questions: [] }))
      const before = await run(findTask(root, "orc-2"))
      expect(before.hold?.history?.length).toBe(1)
      expect(before.spec.dependsOn).toEqual(["orc-1"])
      expect(await run(editTask(root, "orc-2", newText))).toBe("edited")
      expect(await run(findTask(root, "orc-2"))).toEqual({ ...before, spec: { ...before.spec, ...newText } })
    })
  })

  test("an edit of a parent keeps its children pointing at it instead of orphaning them", async () => {
    await withRoot(async (root) => {
      await run(addTask(root, { ...spec, kind: "parent" }))
      await run(addTask(root, { ...spec, parent: "orc-1" }))
      const parentText = { title: "Ship the map", body: "# Ship the map\n\n## Done when\n\n- the map is in docs\n" }
      expect(await run(editTask(root, "orc-1", parentText))).toBe("edited")
      expect((await run(findTask(root, "orc-1"))).spec).toMatchObject({ kind: "parent", ...parentText })
      expect((await run(findTask(root, "orc-2"))).spec.parent).toBe("orc-1")
    })
  })

  test("an edit of a started task is refused instead of changing the text its run already read", async () => {
    await withRoot(async (root) => {
      const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }
      await run(addTask(root, spec))
      await run(claimTask(root, "orc-1"))
      await run(writeTaken(root, { spec: { ...spec, id: "orc-1" }, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
      const file = join(root, "taken", "orc-1.md")
      const before = await readFile(file, "utf8")
      const failure = await run(Effect.flip(editTask(root, "orc-1", newText)))
      expect(failure.detail).toBe("orc-1 is started, and a run has read its text, so only a new task is edited")
      expect(await readFile(file, "utf8")).toBe(before)
    })
  })

  test("a text with no title is refused instead of written as a blank task", async () => {
    await withRoot(async (root) => {
      await run(addTask(root, spec))
      const file = join(root, "new", "orc-1.md")
      const before = await readFile(file, "utf8")
      const blank = join(root, "blank.md")
      await writeFile(blank, "\n#  \n\n")
      const place = { home: root, cwd: root, stdin: Effect.succeed(""), stdinIsTerminal: false }
      const failure = await run(Effect.flip(edit(root, { kind: "EditTask", id: "orc-1", task: { kind: "file", path: blank } }, place)))
      expect(failure.detail).toBe("the task file " + blank + " holds no title")
      expect(await readFile(file, "utf8")).toBe(before)
    })
  })
})
