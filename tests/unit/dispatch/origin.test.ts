import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { findTask } from "../../../packages/run/src/entities/backlog/index"
import { recordOrigin } from "../../../packages/run/src/widgets/beat/beat-origin"
import type { ReadTaskRun } from "../../../packages/run/src/widgets/beat/beat-resume"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const refusal = <A, E extends { readonly detail: string }>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<string> =>
  Effect.runPromise(effect.pipe(Effect.flip, Effect.map((error) => error.detail), Effect.provide(BunServices.layer)))

const parkedFile = (id: string, origin: string) => [
  "---",
  "id: " + JSON.stringify(id),
  "title: \"Do the thing\"",
  "project: \"orc\"",
  "kind: \"ship\"",
  "machine: null",
  "depends_on: []",
  "created: \"2026-11-01T10:00:00.000Z\"",
  "parked_branch: " + JSON.stringify("orc/" + id),
  "parked_questions: [{\"id\":\"R1\",\"text\":\"Keep the output contract?\",\"asked_at\":\"2026-11-02T10:29:00.000Z\",\"answer\":\"Keep it\",\"answered_at\":\"2026-11-03T10:00:00.000Z\"}]",
  ...origin === "" ? [] : ["parked_origin: " + origin],
  "---",
  "# Do the thing",
  ""
].join("\n")

const runs: ReadonlyMap<string, string> = new Map([["orc-1", "run-of-orc-1"], ["orc-2", "run-of-orc-2"]])

const readRun: ReadTaskRun = (task) => Effect.succeed({ kind: "read", run: runs.get(task.spec.id) ?? null, status: "failed" })

const withRoot = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-origin-"))
  try {
    await mkdir(join(root, "new"), { recursive: true })
    await writeFile(join(root, "dispatch.json"), JSON.stringify({
      machines: [{ name: "winbox", slots: 1, start: ["true"] }],
      quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", kind: "none" }], floorPercent: 15 }
    }))
    await writeFile(join(root, "new", "orc-1.md"), parkedFile("orc-1", ""))
    await writeFile(join(root, "new", "orc-2.md"), parkedFile("orc-2", ""))
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const origin = (id: string, machine: string, runId: string) => ({ kind: "RecordOrigin" as const, id, machine, run: runId })

describe("orc backlog origin", () => {
  test("records the machine and run of a parked task that has none instead of leaving it waiting", async () => {
    await withRoot(async (root) => {
      expect(await run(recordOrigin(root, root, origin("orc-1", "winbox", "run-of-orc-1"), readRun))).toBe(
        "recorded run run-of-orc-1 on winbox as the origin of orc-1, so the beat resumes it there"
      )
      expect((await run(findTask(root, "orc-1"))).parked?.origin).toEqual({ machine: "winbox", run: "run-of-orc-1" })
    })
  })

  test("a second origin for a task that already has one is refused instead of replacing the recorded run", async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, "new", "orc-1.md"), parkedFile("orc-1", JSON.stringify({ machine: "winbox", run: "run-of-orc-1" })))
      const before = await readFile(join(root, "new", "orc-1.md"), "utf8")
      expect(await refusal(recordOrigin(root, root, origin("orc-1", "winbox", "run-of-orc-1"), readRun))).toBe("orc-1 already resumes run run-of-orc-1 on winbox")
      expect(await readFile(join(root, "new", "orc-1.md"), "utf8")).toBe(before)
    })
  })

  test("a machine dispatch.json does not name is refused instead of pinning the task to a machine the beat cannot reach", async () => {
    await withRoot(async (root) => {
      expect(await refusal(recordOrigin(root, root, origin("orc-1", "macbox", "run-of-orc-1"), readRun))).toBe("the machine macbox is not in dispatch.json")
      expect((await run(findTask(root, "orc-1"))).parked?.origin).toBeUndefined()
    })
  })

  test("another task's run is refused instead of resuming this task on that task's branch", async () => {
    await withRoot(async (root) => {
      expect(await refusal(recordOrigin(root, root, origin("orc-1", "winbox", "run-of-orc-2"), readRun))).toBe(
        "run run-of-orc-2 is not the run of orc-1 on winbox: the runner now reports run-of-orc-1"
      )
      expect((await run(findTask(root, "orc-1"))).parked?.origin).toBeUndefined()
    })
  })

  test("a task that is not parked is refused instead of gaining an origin it never ran", async () => {
    await withRoot(async (root) => {
      const plain = parkedFile("orc-1", "").split("\n").filter((line) => !line.startsWith("parked_")).join("\n")
      await writeFile(join(root, "new", "orc-1.md"), plain)
      expect(await refusal(recordOrigin(root, root, origin("orc-1", "winbox", "run-of-orc-1"), readRun))).toBe("orc-1 is not parked, so it has no origin to record")
    })
  })
})
