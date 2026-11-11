import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { addTask, claimTask, listTasks, writeTaken } from "../../../packages/run/src/dispatch/backlog"
import { runBeat } from "../../../packages/run/src/dispatch/beat"
import { formatBeat } from "../../../packages/run/src/dispatch/board"
import { taskLabel } from "../../../packages/run/src/dispatch/pueue-status"
import { insertRun, openDatabase } from "../../../packages/run/src/run-history"
import { quietSources } from "../../lib/beat-sources"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = { title: "Ship task splitting", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], created: "2026-11-11T10:00:00.000Z", body: "# Ship task splitting\n" }
const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-11-11T10:01:00.000Z" }
const started = { at: "2026-11-11T10:02:00.000Z", log: "/logs/orc-1.log" }
const quota = { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", kind: "token-file", tokenFile: "/secrets/main-token" }], floorPercent: 15 } as const
const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })

const proposal = {
  schema: "orc.split.v1",
  plan: "split",
  reason: "it touches the record and the listing",
  done: ["a big change lands as linked children"],
  children: [
    { title: "Record the split", body: "Add the split mark.", after: [] },
    { title: "Show the plan", body: "List the children.", after: [1] }
  ]
}

const pueueFailed = (root: string): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> => {
  const status = JSON.stringify({ tasks: { "11": { id: 11, label: taskLabel(root, "orc-1"), group: "orc", path: "/checkout", status: { Done: { start: started.at, end: "2026-11-11T10:05:00.000Z", result: { Failed: 1 } } } } } })
  return Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    const reply = (text: string) => real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + text + "\nJ"]))
    return ChildProcessSpawner.make((command) =>
      ChildProcess.isStandardCommand(command) && command.command === "pueue"
        ? reply(status)
        : ChildProcess.isStandardCommand(command) && command.command === "orc-quota" ? reply(quotaReply) : real.spawn(command)
    )
  })).pipe(Layer.provide(BunServices.layer))
}

const beatAfterRun = async (endReason: string, body: (root: string, lines: ReadonlyArray<string>) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-run-split-"))
  try {
    await writeFile(join(root, "dispatch.json"), JSON.stringify({ machines: [{ name: "mac", slots: 4, start: ["sh", "-c", "true", "runner", "start"] }], quota }))
    await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: "/checkout" } }] }))
    await run(addTask(root, spec))
    await run(claimTask(root, "orc-1"))
    await run(writeTaken(root, { spec: { ...spec, id: "orc-1" }, hold: null, parked: null, state: { kind: "started", claim, started } }))
    await run(Effect.acquireUseRelease(
      openDatabase(root),
      (db) => Effect.sync(() => insertRun(db, { id: "run-1", project: "/checkout", branch: "orc/orc-1", taskFile: "orc-1.md", status: "failed", started: started.at, prLink: null, endReason })),
      (db) => Effect.sync(() => db.close())
    ))
    const report = await Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueFailed(root)))))
    await body(root, formatBeat(report).split("\n"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("the beat applying a worker's split proposal", () => {
  test("a valid proposal turns the task into a parent and starts its free child instead of closing the task failed", async () => {
    await beatAfterRun("split proposal: " + JSON.stringify(proposal), async (root, lines) => {
      const tasks = await run(listTasks(root))
      const parent = tasks.find((task) => task.spec.id === "orc-1")
      expect(parent?.spec.kind).toBe("parent")
      expect(parent?.state.kind).toBe("new")
      expect(parent?.spec.split).toEqual({ by: "run", reason: proposal.reason })
      expect(parent?.spec.body).toBe("# Ship task splitting\n\n## Done when\n\n- a big change lands as linked children\n")
      const children = tasks.filter((task) => task.spec.parent === "orc-1")
      expect(children.map((child) => [child.spec.id, child.spec.kind, child.spec.title, child.spec.dependsOn, child.state.kind])).toEqual([
        ["orc-2", "ship", "Record the split", [], "started"],
        ["orc-3", "ship", "Show the plan", ["orc-2"], "new"]
      ])
      expect(lines).toContain("split orc-1 on mac into orc-2, orc-3: " + proposal.reason)
      expect(lines.some((line) => line.startsWith("closed orc-1"))).toBe(false)
      const event = await readFile(join(root, "events", "orc-1.split.json"), "utf8")
      expect(JSON.parse(event)).toMatchObject({ text: "orc-1 Ship task splitting split at run into orc-2 Record the split, orc-3 Show the plan: " + proposal.reason })
    })
  })

  test("an invalid proposal closes the task failed instead of creating children", async () => {
    const reason = "invalid split proposal: printed no orc.split.v1 document"
    await beatAfterRun(reason, async (root, lines) => {
      const tasks = await run(listTasks(root))
      expect(tasks.map((task) => [task.spec.id, task.spec.kind, task.state.kind])).toEqual([["orc-1", "ship", "closed"]])
      expect(lines).toContain("closed orc-1 failed on mac: " + reason)
    })
  })
})
