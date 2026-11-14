import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { addTask, claimTask, findTask, listTasks, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { dropTask } from "../../../packages/run/src/features/backlog-planning/index"
import { runBeat } from "../../../packages/run/src/widgets/beat/beat"
import { quietSources } from "../../lib/beat-sources"
import type { LoadReading } from "../../../packages/run/src/widgets/beat/load"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const at = "2026-10-28T10:00:00.000Z"

const withRoot = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-drop-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })

const quotaStub = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
  const real = yield* ChildProcessSpawner.ChildProcessSpawner
  return ChildProcessSpawner.make((command) =>
    ChildProcess.isStandardCommand(command) && command.command === "orc-quota"
      ? real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + quotaReply + "\nJ"]))
      : real.spawn(command)
  )
})).pipe(Layer.provide(BunServices.layer))

const idle = (): Effect.Effect<LoadReading> => Effect.succeed({ kind: "read", fiveMinute: 0, heavy: { kind: "read", queued: 0, bypassWeek: 0 } })

describe("orc backlog drop", () => {
  test("a dropped task never starts on the next beat instead of being taken from new like an open task", async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, "dispatch.json"), JSON.stringify({
        machines: [{ name: "mac", slots: 2, start: ["true", "runner", "start"] }],
        quota: { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: "/secrets/main-token" }], floorPercent: 15 }
      }))
      await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: root } }] }))
      await run(addTask(root, spec))
      await run(addTask(root, { ...spec, title: "Fix the other thing" }))
      await run(dropTask(root, "orc-1", "no longer wanted", at))
      const report = await Effect.runPromise(runBeat(root, root, quietSources(idle)).pipe(Effect.provide(Layer.merge(BunServices.layer, quotaStub))))
      expect(report.actions.flatMap((action) => action.kind === "started" ? [action.task] : [])).toEqual(["orc-2"])
      const dropped = await run(findTask(root, "orc-1"))
      expect(dropped.state).toEqual({ kind: "closed", claim: null, closing: { outcome: "dropped", reason: "no longer wanted" }, closedAt: at, postedAt: null })
      expect(await readFile(join(root, "closed", "orc-1.md"), "utf8")).toContain("outcome: \"dropped\"")
    })
  })

  test("a task another open task waits on is refused instead of leaving its dependent waiting for good", async () => {
    await withRoot(async (root) => {
      await run(addTask(root, spec))
      await run(addTask(root, { ...spec, dependsOn: ["orc-1"] }))
      const file = join(root, "new", "orc-1.md")
      const before = await readFile(file, "utf8")
      const failure = await run(Effect.flip(dropTask(root, "orc-1", "no longer wanted", at)))
      expect(failure.detail).toBe("orc-2 waits on orc-1, so change that with orc backlog depend first")
      expect(await readFile(file, "utf8")).toBe(before)
    })
  })

  test("a started task is refused instead of closing it under its live run", async () => {
    await withRoot(async (root) => {
      const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }
      await run(addTask(root, spec))
      await run(claimTask(root, "orc-1"))
      await run(writeTaken(root, { spec: { ...spec, id: "orc-1" }, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
      const failure = await run(Effect.flip(dropTask(root, "orc-1", "no longer wanted", at)))
      expect(failure.detail).toBe("orc-1 is started, and only a new task drops, so end its run with orc backlog stop orc-1")
      expect((await run(listTasks(root))).map((task) => task.spec.id + ":" + task.state.kind)).toEqual(["orc-1:started"])
    })
  })

  test("a parent with an open child is refused instead of closing over the child still in its plan", async () => {
    await withRoot(async (root) => {
      await run(addTask(root, { ...spec, kind: "parent" }))
      await run(addTask(root, { ...spec, parent: "orc-1" }))
      const failure = await run(Effect.flip(dropTask(root, "orc-1", "no longer wanted", at)))
      expect(failure.detail).toBe("orc-1 is a parent with the open children orc-2, so close them or take them out of its plan first")
    })
  })
})
