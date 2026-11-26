import { flagQuestion } from "../../lib/attention-question"
import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { addTask, listTasks, type Parked, renderTaskFile } from "../../../packages/run/src/entities/backlog/index"
import { closeFinished } from "../../../packages/run/src/widgets/beat/beat-close"
import { openItem, openItems } from "../../../packages/run/src/entities/attention/attention"
import { backlogStates, beatWith, config, macProjects, pueueDone, recordRun, run, spec, startTaskOne, withBacklog } from "../../lib/dispatch-beat"

describe("the beat's closing sweep", () => {
  test("a runner close withdraws old attention before a caller can leave stale merge requests open", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["true"], null)
      const task = (await run(listTasks(root))).at(0)
      if (task === undefined) {
        throw new Error("the backlog holds no orc-1")
      }
      for (const kind of ["review-question", "pr-ready", "check-red", "run-died", "failing-command"] as const) {
        await run(openItem(root, "orc-1." + kind, { ...flagQuestion, kind, task: "orc-1", text: "Old request", asked: spec.created, owner: "user" }))
      }
      const progress = await run(closeFinished({ root, home: root, config }, task))
      expect(progress).toMatchObject({ kind: "ended", action: { kind: "closed", task: "orc-1", outcome: "failed" } })
      expect(await backlogStates(root)).toEqual(["orc-1:closed"])
      expect(await run(openItems(root))).toEqual([])
    })
  })

  test("a failed start preserves unanswered parked history instead of deleting it or leaving its attention open", async () => {
    await withBacklog(async (root) => {
      await writeFile(join(root, "dispatch.json"), JSON.stringify({ ...config, machines: [{ name: "mac", slots: 1, start: ["true"] }] }))
      await writeFile(join(root, "projects.json"), JSON.stringify({ projects: macProjects }))
      const added = await run(addTask(root, spec))
      const parked: Parked = {
        branch: "orc/orc-1",
        origin: { machine: "mac", run: "run-1" },
        questions: [
          { id: "r2", text: "Keep the old flag?", asked: spec.created, blocks: true, answer: { decider: "owner" as const, words: "Keep it", at: spec.created, relayedTo: null } },
          { id: "ask-1", text: "Pick a color?", asked: spec.created, blocks: false, answer: null, owner: "user" as const }
        ]
      }
      await writeFile(join(root, "new", "orc-1.md"), renderTaskFile({ ...added, parked }))
      await recordRun(root, "https://github.com/example/orc/pull/7")
      const spawner = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
        const real = yield* ChildProcessSpawner.ChildProcessSpawner
        return ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) && command.options.env?.ORC_TASK_ID === "orc-1"
            ? real.spawn(ChildProcess.make(join(root, "missing-start-command")))
            : real.spawn(command)
        )
      })).pipe(Layer.provide(pueueDone(root, "Success")))
      const report = await beatWith(root, spawner)
      expect(report.actions).toContainEqual(expect.objectContaining({ kind: "start-failed", task: "orc-1" }))
      const closed = (await run(listTasks(root))).at(0)
      expect(closed).toMatchObject({ state: { kind: "closed", closing: { outcome: "start-failed" } }, parked })
      expect((await run(openItems(root))).map(({ item }) => item.kind)).toEqual(["run-died"])
    })
  })
})
