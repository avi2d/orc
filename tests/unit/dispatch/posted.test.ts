import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { addTask, claimTask, closeStartedTask, listTasks, markPosted, writeTaken } from "../../../packages/run/src/dispatch/backlog"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = { title: "Fix the thing", project: "orc", machine: null, dependsOn: [], created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

describe("marking a close posted", () => {
  test("of eight racing marks of one close exactly one posts it, not none and not two", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-posted-"))
    try {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      await run(writeTaken(root, { spec: record.spec, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: root + "/logs/task-1.log" } } }))
      await run(closeStartedTask(root, record.spec.id, "done", "", null, "2026-10-27T11:00:00.000Z"))
      const marks = await run(Effect.all(Array.from({ length: 8 }, () => markPosted(root, "task-1", "2026-10-27T11:01:00.000Z")), { concurrency: "unbounded" }))
      expect(marks.filter(Boolean)).toHaveLength(1)
      expect((await run(listTasks(root))).map((task) => task.state.kind === "closed" ? task.state.postedAt : null)).toEqual(["2026-10-27T11:01:00.000Z"])
      expect(await readdir(join(root, "closed"))).toEqual(["task-1.md"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
