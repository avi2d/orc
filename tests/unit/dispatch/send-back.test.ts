import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { addTask, claimTask, closeStartedTask, findTask, taskPr, type TaskRecord, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { sendBackClosedTask } from "../../../packages/run/src/entities/parked-runs/index"
import { sendBack } from "../../../packages/run/src/features/queueing-a-task/index"

const pr = "https://github.com/acme/orc/pull/8"

const ghReplying = (state: "OPEN" | "MERGED" | "CLOSED") => Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
  const real = yield* ChildProcessSpawner.ChildProcessSpawner
  const view = JSON.stringify({ state, headRefOid: "0123456789abcdef0123456789abcdef01234567", baseRefName: "main", statusCheckRollup: [] })
  return ChildProcessSpawner.make((command) =>
    ChildProcess.isStandardCommand(command) && command.command === "gh"
      ? real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + view + "\nJ"]))
      : real.spawn(command)
  )
})).pipe(Layer.provide(BunServices.layer))

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-send-back-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const spec = { title: "Tidy the docs", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-11-01T10:00:00.000Z", body: "# Tidy the docs\n" }

const claim = { beat: "beat-1", machine: "linux", account: "main", takenAt: "2026-11-01T10:01:00.000Z" }

const startAndClose = async (root: string, record: TaskRecord, outcome: "done" | "failed", delivered: string | null): Promise<TaskRecord> => {
  await run(claimTask(root, "orc-1"))
  await run(writeTaken(root, { ...record, state: { kind: "started", claim, started: { at: "2026-11-01T10:02:00.000Z", log: "/tmp/task.log" } } }))
  return run(closeStartedTask(root, "orc-1", outcome, outcome === "done" ? "" : "the checks failed", { pr: delivered, report: null }, "2026-11-01T11:00:00.000Z"))
}

const sentBackWithPr = async (root: string): Promise<TaskRecord> => {
  const added = await run(addTask(root, spec))
  await startAndClose(root, added, "done", pr)
  return run(sendBackClosedTask(root, "orc-1", "rename the flag", "2026-11-01T12:00:00.000Z", { machine: "linux", run: "origin-run" }))
}

describe("a sent-back task keeps its PR", () => {
  test("a second send-back after the PR merged is refused instead of pushing a second PR", async () => {
    await withBacklog(async (root) => {
      await sentBackWithPr(root)
      const before = await readFile(join(root, "new", "orc-1.md"), "utf8")
      const refused = await Effect.runPromise(
        sendBack(root, root, { kind: "SendBack", id: "orc-1", words: "and its help" }, "2026-11-01T13:00:00.000Z").pipe(
          Effect.flip,
          Effect.map((error) => error.detail),
          Effect.provide(Layer.mergeAll(BunServices.layer, ghReplying("MERGED")))
        )
      )
      expect(refused).toBe("orc backlog send-back refused: " + pr + " is merged, so no run can update it")
      expect(await readFile(join(root, "new", "orc-1.md"), "utf8")).toBe(before)
    })
  })

  test("a sent-back run that fails before its PR step still names its PR instead of closing with none", async () => {
    await withBacklog(async (root) => {
      const sent = await sentBackWithPr(root)
      const closed = await startAndClose(root, sent, "failed", null)
      expect(taskPr(closed)).toBe(pr)
      expect(taskPr(await run(findTask(root, "orc-1")))).toBe(pr)
    })
  })

  test("a second send-back while the PR is open adds the review", async () => {
    await withBacklog(async (root) => {
      await sentBackWithPr(root)
      const added = await Effect.runPromise(
        sendBack(root, root, { kind: "SendBack", id: "orc-1", words: "and its help" }, "2026-11-01T13:00:00.000Z").pipe(
          Effect.provide(Layer.mergeAll(BunServices.layer, ghReplying("OPEN")))
        )
      )
      expect(added).toBe("added the review to orc-1, so the next beat resumes run origin-run on orc/orc-1 with every review sent back")
    })
  })
})
