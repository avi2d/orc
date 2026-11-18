import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Result, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { parseArgs } from "../../../packages/run/src/app/args"
import { addTask, decisionAnswer, listTasks } from "../../../packages/run/src/entities/backlog/index"
import { answerTask } from "../../../packages/run/src/entities/parked-runs/index"
import { holdTask } from "../../../packages/run/src/features/backlog-planning/index"
import { mergeTask } from "../../../packages/run/src/features/merging-a-pr/index"
import { readRequest } from "../../../packages/run/src/features/queueing-a-task/runner-request"
import { runBeat } from "../../../packages/run/src/widgets/beat/beat"
import { quietSources } from "../../lib/beat-sources"
import { realBacklogStdout } from "../../lib/dispatch-fixture"
import { formatBeat } from "../../../packages/run/src/widgets/beat/board"
import type { DispatchConfig } from "../../../packages/run/src/shared/config/dispatch-config"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-decision-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const config: DispatchConfig = {
  machines: [{ name: "mac", slots: 1, start: ["true"] }, { name: "linux", slots: 4, start: ["true"] }],
  quota: { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", kind: "token-file", tokenFile: "/secrets/main-token" }], floorPercent: 15 }
}

const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })

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

type BeatSpawner = Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>

const macProjects = [{ name: "orc", checkouts: { mac: "/checkout" } }]

const beatWith = (root: string, spawner: BeatSpawner) =>
  Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, spawner))))

const backlogStates = async (root: string): Promise<ReadonlyArray<string>> =>
  (await run(listTasks(root))).map((task) => task.spec.id + ":" + task.state.kind)

const decisionSpec = { ...spec, title: "Which button goes first", kind: "decision" as const, priority: null, body: "# Which button goes first\n\nThe left one or the right one?\n" }

const answeredAt = "2026-10-27T10:30:00.000Z"

const decisionBacklog = async (root: string): Promise<void> => {
  await writeFile(join(root, "dispatch.json"), JSON.stringify({ ...config, machines: [{ name: "mac", slots: 1, start: ["true"] }] }))
  await writeFile(join(root, "projects.json"), JSON.stringify({ projects: macProjects }))
  await run(addTask(root, decisionSpec))
}

const noPueueTasks = (): BeatSpawner => pueueStub(JSON.stringify({ tasks: {} })).pipe(Layer.provide(BunServices.layer))

const failureDetail = async <A, E extends { readonly detail: string }>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<string | null> => {
  const result = await run(Effect.result(effect))
  return Result.isFailure(result) ? result.failure.detail : null
}

const ShownBacklog = Schema.Struct({
  tasks: Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.String, answer: Schema.NullOr(Schema.Struct({ words: Schema.String, at: Schema.String })) }))
})

describe("a decision", () => {
  test("the beat leaves a decision new and says it waits for the captain instead of starting it on a free machine", async () => {
    await withBacklog(async (root) => {
      await decisionBacklog(root)
      const report = await beatWith(root, noPueueTasks())
      expect(formatBeat(report).split("\n").filter((line) => line.startsWith("waits "))).toEqual(["waits orc-1: decision for the captain"])
      expect(await backlogStates(root)).toEqual(["orc-1:new"])
    })
  })
  test("answering a decision closes it done with reason answered and keeps the words instead of releasing it to run", async () => {
    await withBacklog(async (root) => {
      await decisionBacklog(root)
      expect(await run(answerTask(root, "orc-1", "use the left one", answeredAt))).toEqual({ kind: "decision" })
      const closed = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
      expect(closed?.state.kind === "closed" ? [closed.state.closing.outcome, closed.state.closing.reason, closed.state.claim] : []).toEqual(["done", "answered", null])
      expect(closed === undefined ? null : decisionAnswer(closed)).toEqual({ words: "use the left one", at: answeredAt })
      const text = await readFile(join(root, "closed", "orc-1.md"), "utf8")
      expect(text).toContain('answer: "use the left one"\n')
      expect(text).toContain('answered_at: "' + answeredAt + '"\n')
      const shown = Schema.decodeUnknownSync(ShownBacklog)(JSON.parse(await realBacklogStdout(root))).tasks.find((task) => task.id === "orc-1")
      expect(shown?.kind).toBe("decision")
      expect(shown?.answer).toEqual({ words: "use the left one", at: answeredAt })
    })
  })
  test("a task waiting on a decision starts after the answer with the question and answer after its own body instead of its body alone", async () => {
    await withBacklog(async (root) => {
      await decisionBacklog(root)
      await run(addTask(root, { ...spec, title: "Build the button", dependsOn: ["orc-1"], body: "# Build the button\n" }))
      const before = await beatWith(root, noPueueTasks())
      expect(formatBeat(before).split("\n").filter((line) => line.startsWith("waits "))).toEqual(["waits orc-2: waits on orc-1", "waits orc-1: decision for the captain"])
      await run(answerTask(root, "orc-1", "use the left one", answeredAt))
      const after = await beatWith(root, noPueueTasks())
      expect(after.actions.map((action) => action.kind + ":" + ("task" in action ? action.task : ""))).toEqual(["started:orc-2"])
      const env = { ORC_TASK_ID: "orc-2", ORC_TASK_FILE: join(root, "taken", "orc-2.md"), ORC_TASK_CHECKOUT: "/checkout", ORC_TASK_PROVIDER: "keyed" }
      const request = await run(readRequest(env, Effect.succeed("")))
      expect(request.body).toBe("# Build the button\n\nThe captain's decision orc-1 asked:\n\n# Which button goes first\n\nThe left one or the right one?\n\nThe captain answered: use the left one\n")
    })
  })
  test("hold and merge refuse a decision instead of holding it or looking for its PR", async () => {
    await withBacklog(async (root) => {
      await decisionBacklog(root)
      const refusal = "is a decision, so it takes no "
      expect(await failureDetail(holdTask(root, "orc-1", { reason: "wait", until: null, questions: [] }))).toContain("orc-1 " + refusal + "hold")
      expect(await failureDetail(mergeTask(root, "orc-1", "captain-word", () => Effect.succeed("sent back")))).toContain("orc-1 " + refusal + "merge")
      expect(await backlogStates(root)).toEqual(["orc-1:new"])
    })
  })
  test("orc run --kind decision is refused instead of running a decision as a task", () => {
    const parsed = parseArgs(["run", "question.md", "--kind", "decision"])
    expect(parsed.kind === "UsageError" ? parsed.detail : parsed.kind).toContain("orc run takes no --kind decision")
  })
})
