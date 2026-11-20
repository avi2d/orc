import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Array as Arr, Effect, FileSystem, Schema } from "effect"
import { askSetupFor, openWorkerAsks } from "../../../packages/run/src/entities/agent/worker-ask"
import { addTask, claimTask, listTasks, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { askStartedTask } from "../../../packages/run/src/entities/parked-runs/index"
import { Asking, askingFileName } from "../../../packages/run/src/entities/review-gate/index"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

const options = [{ text: "Red", outcome: "The page turns red" }, { text: "Blue", outcome: "The page turns blue" }]

describe("a worker question asked through orc_ask", () => {
  test("reaches the parked question in the task record with each option's outcome and the recommendation, instead of the bare text", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-worker-ask-"))
    try {
      const runDir = join(root, "run")
      const setup = askSetupFor(runDir, join(runDir, "session"), 600, [])
      await mkdir(setup.askDir, { recursive: true })
      await writeFile(join(setup.askDir, "call-1.ask.json"), JSON.stringify({ question: "Which colour?", blocks: false, options, recommendation: "Blue" }))
      await run(Effect.gen(function*() {
        yield* openWorkerAsks(yield* FileSystem.FileSystem, setup).tick
      }))
      const asking = Schema.decodeUnknownSync(Asking)(JSON.parse(await readFile(join(runDir, askingFileName), "utf8")))
      if (!Arr.isReadonlyArrayNonEmpty(asking.questions)) {
        throw new Error("asking.json holds no question")
      }
      const question = Arr.headNonEmpty(asking.questions)
      expect(question.options).toEqual(options)
      expect(question.recommendation).toBe("Blue")
      expect(question.text).toBe("Which colour?\nA) Red\n   Leads to: The page turns red\nB) Blue\n   Leads to: The page turns blue\nRecommended: B) Blue")

      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
      expect(await run(askStartedTask(root, "orc-1", { asked: asking.asked, questions: asking.questions }))).toBe(true)
      const parked = (await run(listTasks(root))).at(0)?.parked?.questions[0]
      expect(parked?.options).toEqual(options)
      expect(parked?.recommendation).toBe("Blue")
      expect(parked?.text).toBe(question.text)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an asking file written before outcomes and recommendations still decodes", () => {
    const old = Schema.decodeUnknownSync(Asking)({ asked: "2026-10-27T10:04:00.000Z", until: "2026-10-27T10:04:00.000Z", questions: [{ id: "ask-1", text: "Which colour?", options: [{ text: "Red" }] }] })
    expect(old.questions[0]?.options).toEqual([{ text: "Red" }])
    expect(old.questions[0]?.recommendation).toBeUndefined()
  })
})
