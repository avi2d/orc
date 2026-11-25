import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { addTask, claimTask, listTasks, writeTaken } from "../../packages/run/src/entities/backlog/index"
import { type BeatReport, runBeat } from "../../packages/run/src/widgets/beat/beat"
import { insertRun, openDatabase } from "../../packages/run/src/entities/run-history/index"
import { type DispatchConfig } from "../../packages/run/src/shared/config/dispatch-config"
import { taskLabel } from "../../packages/run/src/shared/process/pueue-status"
import { quietSources } from "./beat-sources"

export const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

export const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-dispatch-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

export const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

export const config: DispatchConfig = {
  machines: [{ name: "mac", slots: 1, start: ["true"] }, { name: "linux", slots: 4, start: ["true"] }],
  quota: { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", kind: "token-file", tokenFile: "/secrets/main-token" }], floorPercent: 15 }
}

export const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })

// Answers pueue status and the quota command itself, and runs every other command for real.
const pueueStub = (statusJson: string): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.make((command) =>
      ChildProcess.isStandardCommand(command) && command.command === "pueue"
        ? real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + statusJson + "\nJ"]))
        : ChildProcess.isStandardCommand(command) && command.command === "orc-quota"
          ? real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + quotaReply + "\nJ"]))
          : real.spawn(command)
    )
  }))

export const macProjects = [{ name: "orc", checkouts: { mac: "/checkout" } }]

export type BeatSpawner = Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>

export const startTaskOne = async (root: string, start: ReadonlyArray<string>, next: { readonly dependsOn: ReadonlyArray<string> } | null): Promise<void> => {
  await writeFile(join(root, "dispatch.json"), JSON.stringify({ ...config, machines: [{ name: "mac", slots: 1, start }] }))
  await writeFile(join(root, "projects.json"), JSON.stringify({ projects: macProjects }))
  await run(addTask(root, spec))
  if (next !== null) {
    await run(addTask(root, { ...spec, title: "Fix the other thing", dependsOn: next.dependsOn }))
  }
  await run(claimTask(root, "orc-1"))
  const first = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
  if (first === undefined) {
    throw new Error("the backlog holds no orc-1")
  }
  await run(writeTaken(root, { spec: first.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
}

export const pueueAnswering = (root: string, status: unknown): BeatSpawner =>
  pueueStub(JSON.stringify({ tasks: { "11": { id: 11, label: taskLabel(root, "orc-1"), group: "orc", path: "/checkout", status } } })).pipe(Layer.provide(BunServices.layer))

export const pueueDone = (root: string, result: unknown): BeatSpawner =>
  pueueAnswering(root, { Done: { start: "2026-10-27T10:02:00.000Z", end: "2026-10-27T10:05:00.000Z", result } })

export const beatWith = (root: string, spawner: BeatSpawner): Promise<BeatReport> =>
  Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, spawner))))

export const backlogStates = async (root: string): Promise<ReadonlyArray<string>> =>
  (await run(listTasks(root))).map((task) => task.spec.id + ":" + task.state.kind)

export const recordRun = (home: string, prLink: string): Promise<void> =>
  run(Effect.acquireUseRelease(
    openDatabase(home),
    (db) => Effect.sync(() => insertRun(db, { id: "run-1", project: "/checkout", branch: "orc/orc-1", taskFile: "orc-1.md", status: "succeeded", started: "2026-10-27T10:02:00.000Z", prLink })),
    (db) => Effect.sync(() => db.close())
  ))
