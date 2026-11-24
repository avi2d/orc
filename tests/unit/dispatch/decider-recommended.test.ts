import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { routeTaskItems } from "../../../packages/run/src/entities/attention/attention"
import { addTask, claimTask, listTasks, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { type AskDecider, DeciderUnheard, decideReviewQuestions, type DeciderRequest } from "../../../packages/run/src/features/decider/index"
import { askStartedTask } from "../../../packages/run/src/entities/parked-runs/index"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const intent = "# Retry the upload\nRetry a failed upload twice, then give up.\n"

const spec = { title: "Retry the upload", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-11-02T10:00:00.000Z", body: intent }

const claim = { beat: "beat-1", machine: "linux", account: "main", takenAt: "2026-11-02T10:01:00.000Z" }

const asked = "2026-11-02T10:20:00.000Z"

type AskedQuestion = { readonly id: string; readonly text: string }

const itemOf = (question: AskedQuestion): string => "orc-1." + question.id + ".2026-11-02T10_20_00_000Z"

const withAskingTask = async (questions: readonly [AskedQuestion, ...ReadonlyArray<AskedQuestion>], body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-decider-recommended-"))
  try {
    const record = await run(addTask(root, spec))
    await run(claimTask(root, record.spec.id))
    await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
    await run(askStartedTask(root, "orc-1", { asked, questions }))
    await run(routeTaskItems(root, await run(listTasks(root)), asked))
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const replying = (reply: string, heard: Array<DeciderRequest> = []): AskDecider => ({
  home: "/nonexistent/orc-home",
  ask: (request) => {
    heard.push(request)
    return reply === "" ? Effect.fail(new DeciderUnheard({ reason: "no reply in this test" })) : Effect.succeed(reply)
  }
})

const itemFile = async (root: string, id: string): Promise<unknown> => JSON.parse(await readFile(join(root, "attention", id + ".json"), "utf8"))

const decide = async (root: string, ask: AskDecider) => run(decideReviewQuestions(root, await run(listTasks(root)), ask))

const policy = await readFile(join(import.meta.dir, "../../../packages/run/agents/decider-policy.md"), "utf8")

const escalationBullet = (start: string): string => {
  const list = policy.slice(policy.indexOf("## Escalation"), policy.indexOf("## Reply"))
  const bullet = list.split("\n").find((line) => line.startsWith("- " + start))
  if (bullet === undefined) {
    throw new Error("the decider policy's Escalation list holds no bullet starting " + JSON.stringify(start))
  }
  return bullet.slice(2)
}

const recommendedRule = "When a review question names a recommended option and the question is not on the never list, answer with that option even when it picks between product choices the intent leaves open or you are not sure."

const escalateOn = (rule: string | undefined): string =>
  JSON.stringify({ decision: "escalate", reason: "the decider would not pick", ...(rule === undefined ? {} : { rule }) })

const twoRemedies = { id: "r2", text: "The retry count is not configurable.\nA) Keep two retries\nB) Read the count from config\nRecommended: Keep two retries" }

describe("a review question with a Recommended: line", () => {
  for (const bullet of ["It picks between product choices", "You are not sure"]) {
    test("escalated by the decider on the policy bullet " + JSON.stringify(bullet) + " is answered with its recommended option, instead of reaching the owner", async () => {
      await withAskingTask([twoRemedies], async (root) => {
        await decide(root, replying(escalateOn(escalationBullet(bullet))))
        expect(await itemFile(root, itemOf(twoRemedies))).toMatchObject({
          owner: "decider",
          decision: { kind: "answered", rule: { quote: recommendedRule, source: "decider policy" } },
          state: { kind: "closed", answer: { words: "Keep two retries" } }
        })
        expect((await run(listTasks(root))).at(0)?.parked?.questions.find((question) => question.id === "r2")?.answer).toMatchObject({ words: "Keep two retries", by: "decider" })
      })
    })
  }

  test("with leading whitespace before Recommended: is still read as the recommended option, instead of escalated", async () => {
    const indented = { id: "r2", text: "Keep the old flag name?\n  Recommended: Rename it" }
    await withAskingTask([indented], async (root) => {
      await decide(root, replying(escalateOn(escalationBullet("You are not sure"))))
      expect(await itemFile(root, itemOf(indented))).toMatchObject({ owner: "decider", state: { kind: "closed", answer: { words: "Rename it" } } })
    })
  })

  const stillEscalated: ReadonlyArray<{ readonly name: string; readonly rule: () => string | undefined }> = [
    { name: "widening the task", rule: () => escalationBullet("It would widen the task") },
    { name: "a name the intent does not give", rule: () => escalationBullet("It asks for an account or a name") },
    { name: "no sentence settling it", rule: () => escalationBullet("No sentence of the rules") },
    { name: "a bullet the policy does not hold", rule: () => "It is a product choice for the author." },
    { name: "no bullet at all", rule: () => undefined }
  ]
  for (const reason of stillEscalated) {
    test("escalated by the decider on " + reason.name + " stays with the owner, instead of being answered with its recommended option", async () => {
      const bucket = { id: "r2", text: "Which bucket name goes in config?\nRecommended: use orc-staging" }
      await withAskingTask([bucket], async (root) => {
        await decide(root, replying(escalateOn(reason.rule())))
        expect(await itemFile(root, itemOf(bucket))).toMatchObject({ owner: "user", decision: { kind: "escalated", reason: "the decider would not pick" }, state: { kind: "open" } })
      })
    })
  }

  test("that the decider never answered stays with the owner when the decider is not heard, instead of being answered with its option", async () => {
    await withAskingTask([twoRemedies], async (root) => {
      await decide(root, replying(""))
      expect(await itemFile(root, itemOf(twoRemedies))).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
    })
  })

  test("behind a list marker is not read as the recommended option, instead of being answered with it", async () => {
    const marked = { id: "r2", text: "Keep the old flag name?\n- Recommended: Rename it" }
    await withAskingTask([marked], async (root) => {
      await decide(root, replying(escalateOn(escalationBullet("You are not sure"))))
      expect(await itemFile(root, itemOf(marked))).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
    })
  })

  test("on the never list reaches the owner with no decider call, instead of being answered with its recommended option", async () => {
    const pushing = { id: "r2", text: "Should the run push the branch itself?\nRecommended: yes" }
    const heard: Array<DeciderRequest> = []
    await withAskingTask([pushing], async (root) => {
      await decide(root, replying(escalateOn(escalationBullet("You are not sure")), heard))
      expect(heard).toHaveLength(0)
      expect(await itemFile(root, itemOf(pushing))).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
    })
  })
})

describe("a worker question with a Recommended: line", () => {
  test("escalated by the decider on an open product choice stays with the owner, instead of orc answering with the worker's own preference", async () => {
    const flag = { id: "ask-1", text: "Name the flag --retries or --attempts?\nRecommended: --retries" }
    await withAskingTask([flag], async (root) => {
      await decide(root, replying(escalateOn(escalationBullet("It picks between product choices"))))
      expect(await itemFile(root, itemOf(flag))).toMatchObject({ kind: "worker-question", owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
    })
  })
})
