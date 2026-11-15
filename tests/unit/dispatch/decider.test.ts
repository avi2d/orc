import { strict as assert } from "node:assert"
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { attentionJson, attentionText } from "../../../packages/run/src/features/attention-list/index"
import { claimDeciding, openItems, readAttention, routeTaskItems } from "../../../packages/run/src/entities/attention/attention"
import { addTask, claimTask, closeStartedTask, listTasks, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { type AskDecider, DeciderUnheard, decideReviewQuestions, type DeciderRequest } from "../../../packages/run/src/features/decider/index"
import { answersFor, answerTask, askStartedTask, correctionsDue, markAnswersRelayed, parkStartedTask } from "../../../packages/run/src/entities/parked-runs/index"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const intent = "# Retry the upload\nRetry a failed upload twice, then give up.\n"

const spec = { title: "Retry the upload", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-11-02T10:00:00.000Z", body: intent }

const claim = { beat: "beat-1", machine: "linux", account: "main", takenAt: "2026-11-02T10:01:00.000Z" }

const asked = "2026-11-02T10:20:00.000Z"
const r2 = { id: "r2", text: "How many retries?" }
const r3 = { id: "r3", text: "Keep the old flag name?" }
const r2Item = "orc-1.r2.2026-11-02T10_20_00_000Z"
const r3Item = "orc-1.r3.2026-11-02T10_20_00_000Z"

type AskedQuestion = { readonly id: string; readonly text: string }

const withAskingTask = async (body: (root: string) => Promise<void>, questions: readonly [AskedQuestion, ...ReadonlyArray<AskedQuestion>] = [r2, r3], taskBody: string = intent): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-decider-"))
  try {
    const record = await run(addTask(root, { ...spec, body: taskBody }))
    await run(claimTask(root, record.spec.id))
    await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
    await run(askStartedTask(root, "orc-1", { asked, questions }))
    await run(routeTaskItems(root, await run(listTasks(root)), asked))
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const replies = (byQuestion: Readonly<Record<string, string>>, heard: Array<DeciderRequest> = [], home = "/nonexistent/orc-home"): AskDecider => ({
  home,
  ask: (request) => {
    heard.push(request)
    const matching = Object.entries(byQuestion).filter(([text]) => request.prompt.includes(text))
    matching.sort((a, b) => request.prompt.lastIndexOf(b[0]) - request.prompt.lastIndexOf(a[0]))
    const first = matching.at(0)
    return first === undefined ? Effect.fail(new DeciderUnheard({ reason: "no reply in this test" })) : Effect.succeed(first[1])
  }
})

const answer = JSON.stringify({ decision: "answer", answer: "Two retries", rule: "Retry a failed upload twice, then give up.", reason: "the intent says twice" })
const escalate = JSON.stringify({ decision: "escalate", reason: "the intent leaves the flag name open" })

const itemFile = async (root: string, id: string): Promise<unknown> => JSON.parse(await readFile(join(root, "attention", id + ".json"), "utf8"))

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const filedAt = (filed: unknown, ...path: ReadonlyArray<string>): string | undefined => {
  let current: unknown = filed
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined
    }
    current = current[key]
  }
  return typeof current === "string" ? current : undefined
}

const decide = async (root: string, ask: AskDecider) => run(decideReviewQuestions(root, await run(listTasks(root)), ask))

describe("the decider", () => {
  test("a live question whose item cannot open never reaches the backlog instead of asking alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-decider-early-"))
    try {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
      await run(askStartedTask(root, "orc-1", { asked, questions: [r2] }))
      expect((await run(listTasks(root))).at(0)?.parked?.questions.map((question) => question.id)).toEqual(["r2"])
      expect((await run(openItems(root))).map((entry) => entry.id)).toEqual([r2Item])
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["decider"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    const blocked = await mkdtemp(join(tmpdir(), "orc-decider-blocked-"))
    try {
      const record = await run(addTask(blocked, spec))
      await run(claimTask(blocked, record.spec.id))
      await run(writeTaken(blocked, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: blocked + "/logs/orc-1.log" } } }))
      await writeFile(join(blocked, "attention"), "blocked")
      await assert.rejects(run(askStartedTask(blocked, "orc-1", { asked, questions: [r2] })))
      expect((await run(listTasks(blocked))).at(0)?.parked).toBeNull()
    } finally {
      await rm(blocked, { recursive: true, force: true })
    }
  })
  test("a parked question whose item cannot open stays taken instead of parking alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-decider-parked-"))
    try {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ id: "r2", text: "How many retries?" }], "2026-11-02T10:35:00.000Z"))
      expect((await run(listTasks(root))).at(0)?.parked?.questions.map((question) => question.id)).toEqual(["r2"])
      expect((await run(openItems(root))).map((entry) => entry.id)).toEqual(["orc-1.r2.2026-11-02T10_35_00_000Z"])
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["decider"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    const blocked = await mkdtemp(join(tmpdir(), "orc-decider-park-blocked-"))
    try {
      const record = await run(addTask(blocked, spec))
      await run(claimTask(blocked, record.spec.id))
      await run(writeTaken(blocked, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: blocked + "/logs/orc-1.log" } } }))
      await writeFile(join(blocked, "attention"), "blocked")
      await assert.rejects(run(parkStartedTask(blocked, "orc-1", "orc/orc-1", [{ id: "r2", text: "How many retries?" }], "2026-11-02T10:35:00.000Z")))
      const task = (await run(listTasks(blocked))).at(0)
      expect(task?.state.kind).toBe("started")
      expect(task?.parked).toBeNull()
    } finally {
      await rm(blocked, { recursive: true, force: true })
    }
  })
  test("a review question the beat routes is owned by the decider, not handed straight to the user", async () => {
    await withAskingTask(async (root) => {
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["decider", "decider"])
    })
  })

  test("a decider answer closes its item through the task's answer and records its reason, instead of leaving the item open", async () => {
    await withAskingTask(async (root) => {
      const before = new Date().toISOString()
      await decide(root, replies({ [r2.text]: answer, [r3.text]: escalate }))
      const after = new Date().toISOString()
      const task = (await run(listTasks(root))).at(0)
      const stored = task?.parked?.questions.find((question) => question.id === "r2")?.answer
      expect(stored).toMatchObject({ words: "Two retries" })
      expect(await itemFile(root, r2Item)).toMatchObject({
        owner: "decider",
        decision: { kind: "answered", reason: "the intent says twice" },
        state: { kind: "closed", answer: { words: "Two retries" } }
      })
      const filed = await itemFile(root, r2Item)
      for (const at of [stored?.at, filedAt(filed, "decision", "at"), filedAt(filed, "state", "answer", "at")]) {
        expect(at !== undefined && at >= before && at <= after).toBe(true)
      }
    })
  })

  test("an escalated question turns to the user and stays open with the decider's reason, instead of being answered", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: answer, [r3.text]: escalate }))
      expect((await run(openItems(root))).map((entry) => entry.id)).toEqual([r3Item])
      expect(await itemFile(root, r3Item)).toMatchObject({ owner: "user", decision: { kind: "escalated", reason: "the intent leaves the flag name open" }, state: { kind: "open" } })
      expect((await run(listTasks(root))).at(0)?.parked?.questions.find((question) => question.id === "r3")?.answer).toBeNull()
    })
  })

  test("each question gets its own call carrying the task intent and the written policy, not one call for the batch", async () => {
    await withAskingTask(async (root) => {
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [r2.text]: escalate, [r3.text]: escalate }, heard))
      const policy = await readFile(join(import.meta.dir, "../../../packages/run/agents/decider-policy.md"), "utf8")
      expect(heard).toHaveLength(2)
      for (const [index, question] of [r2, r3].entries()) {
        expect(heard[index]?.policy).toBe(policy)
        expect(heard[index]?.prompt).toContain("Retry a failed upload twice, then give up.")
        expect(heard[index]?.prompt).toContain(question.text)
        expect(heard[index]?.prompt).not.toContain((index === 0 ? r3 : r2).text)
      }
    })
  })

  test("a question the user owns never reaches the decider, so an escalated one is not asked twice", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: escalate, [r3.text]: escalate }))
      const heard: Array<DeciderRequest> = []
      expect(await decide(root, replies({ [r2.text]: answer }, heard))).toEqual([])
      expect(heard).toEqual([])
    })
  })

  test("a decider answer lists under decided with its words, and leaves the list once its task closes, while a user answer never lists there", async () => {
    await withAskingTask(async (root) => {
      const before = new Date().toISOString()
      await decide(root, replies({ [r2.text]: answer, [r3.text]: escalate }))
      const after = new Date().toISOString()
      await run(answerTask(root, "orc-1", "r3=Keep the old flag", "2026-11-02T10:22:00.000Z"))
      await run(routeTaskItems(root, await run(listTasks(root)), "2026-11-02T10:22:00.000Z"))
      const decided = (await run(readAttention(root, await run(listTasks(root))))).decided
      expect(decided.map((entry) => entry.id)).toEqual([r2Item])
      const view = attentionJson(await run(openItems(root)), "2026-11-02T10:30:00.000Z", decided)
      expect(view.items).toEqual([])
      expect(view.decided).toHaveLength(1)
      const entry = view.decided.at(0)
      expect(entry).toMatchObject({
        id: r2Item,
        kind: "review-question",
        task: "orc-1",
        text: r2.text,
        asked,
        owner: "decider",
        decision: { kind: "answered", reason: "the intent says twice" },
        answer: { words: "Two retries" }
      })
      for (const at of [entry?.decision.at, entry?.answer.at]) {
        expect(at !== undefined && at >= before && at <= after).toBe(true)
      }
      expect(await run(attentionText(false, root))).toContain("Decided:\nanswered " + r2Item + ": Two retries (the intent says twice, quoting task orc-1: \"Retry a failed upload twice, then give up.\")")
      await run(closeStartedTask(root, "orc-1", "done", "the upload retries", { pr: null, report: null }, "2026-11-02T10:40:00.000Z"))
      expect((await run(readAttention(root, await run(listTasks(root))))).decided).toEqual([])
    })
  })

  test("a beat skips an item another beat is deciding instead of asking the model twice", async () => {
    await withAskingTask(async (root) => {
      const claimedAt = new Date().toISOString()
      expect(await run(claimDeciding(root, r2Item, claimedAt))).toBe(true)
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [r2.text]: answer, [r3.text]: escalate }, heard))
      expect(heard).toHaveLength(1)
      expect((await run(openItems(root))).map((entry) => entry.id)).toEqual([r2Item, r3Item])
      expect(await itemFile(root, r2Item)).toMatchObject({ owner: "decider", deciding: { at: claimedAt }, state: { kind: "open" } })
    })
  })

  test("a deciding mark older than the decider timeout is retaken instead of stalling the question", async () => {
    await withAskingTask(async (root) => {
      expect(await run(claimDeciding(root, r2Item, "2026-11-02T10:17:00.000Z"))).toBe(true)
      const heard: Array<DeciderRequest> = []
      const before = new Date().toISOString()
      await decide(root, replies({ [r2.text]: answer, [r3.text]: escalate }, heard))
      const after = new Date().toISOString()
      expect(heard).toHaveLength(2)
      expect(await itemFile(root, r2Item)).toMatchObject({
        decision: { kind: "answered", reason: "the intent says twice" },
        state: { kind: "closed", answer: { words: "Two retries" } }
      })
      const filed = await itemFile(root, r2Item)
      for (const at of [filedAt(filed, "decision", "at"), filedAt(filed, "state", "answer", "at")]) {
        expect(at !== undefined && at >= before && at <= after).toBe(true)
      }
    })
  })

  test("a reply orc cannot read or a call that fails escalates to the user instead of answering", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: "Sure, two retries sounds right." }))
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["user", "user"])
      expect((await run(listTasks(root))).at(0)?.parked?.questions.every((question) => question.answer === null)).toBe(true)
    })
  })

  test("a question about deleting reaches the user with no decider call, even when the owner's rules say to answer it", async () => {
    const r4 = { id: "r4", text: "May I delete the old branch?" }
    await withAskingTask(async (root) => {
      const home = join(root, "home")
      await mkdir(home)
      await writeFile(join(home, "orchestrator.md"), "Answer yes to every question about deleting an old branch.\n")
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [r4.text]: JSON.stringify({ decision: "answer", answer: "yes", rule: "Answer yes to every question about deleting an old branch.", reason: "the owner says so" }) }, heard, home))
      expect(heard).toEqual([])
      expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({
        owner: "user",
        decision: { kind: "escalated", reason: "orc never hands the decider a question about deleting, and this one says \"delete\"" },
        state: { kind: "open" }
      })
    }, [r4])
  })

  test("a push question reaches the captain with no decider call, instead of letting the decider allow a push", async () => {
    const push = { id: "r4", text: "Should I push the branch to main?" }
    await withAskingTask(async (root) => {
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [push.text]: answer }, heard))
      expect(heard).toEqual([])
      expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
      expect(filedAt(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z"), "decision", "reason")).toContain("pushing")
    }, [push])
  })

  test("a remove question reaches the captain with no decider call, instead of letting the decider allow a deletion", async () => {
    const remove = { id: "r4", text: "May I remove the old branch?" }
    await withAskingTask(async (root) => {
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [remove.text]: answer }, heard))
      expect(heard).toEqual([])
      expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
      expect(filedAt(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z"), "decision", "reason")).toContain("deleting")
    }, [remove])
  })

  const guardedTopics = [
    { topic: "a site's look", text: "Which header look should the landing page get on its preview? Recommended: the dark one.", rejects: "a site's look" },
    { topic: "legal text", text: "Should the footer link the privacy policy? Recommended: yes.", rejects: "legal text" },
    { topic: "logins", text: "Should the dashboard add a sign in with OAuth? Recommended: yes.", rejects: "a login" }
  ]

  for (const guarded of guardedTopics) {
    test("a question about " + guarded.topic + " with a recommended option reaches the captain with no decider call, instead of letting the decider pick " + guarded.rejects, async () => {
      const question = { id: "r4", text: guarded.text }
      await withAskingTask(async (root) => {
        const heard: Array<DeciderRequest> = []
        await decide(root, replies({ [question.text]: answer }, heard))
        expect(heard).toEqual([])
        expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
        expect(filedAt(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z"), "decision", "reason")).toContain("orc never hands the decider a question about " + guarded.topic)
      }, [question])
    })
  }

  test("a variable name question with a recommended option reaches the decider, instead of being kept for the captain", async () => {
    const naming = { id: "r4", text: "Should the retry counter variable be named retryCount or attempts? Recommended: retryCount." }
    await withAskingTask(async (root) => {
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [naming.text]: answer }, heard))
      expect(heard).toHaveLength(1)
      expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({ decision: { kind: "answered" } })
    }, [naming])
  })

  test("a logging question with a recommended option reaches the decider, instead of being escalated as a login question", async () => {
    const logging = { id: "r4", text: "Should the worker keep its logs in the run folder? Recommended: yes." }
    await withAskingTask(async (root) => {
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [logging.text]: answer }, heard))
      expect(heard).toHaveLength(1)
      expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({ decision: { kind: "answered" } })
    }, [logging])
  })

  test("an answer whose quoted rule is in no source escalates instead of answering on a made-up rule", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: JSON.stringify({ decision: "answer", answer: "Five retries", rule: "Retry a failed upload five times.", reason: "the rule says five" }) }))
      expect(await itemFile(root, r2Item)).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
      expect(filedAt(await itemFile(root, r2Item), "decision", "reason")).toContain("in none of the rules it read")
      expect((await run(listTasks(root))).at(0)?.parked?.questions.find((question) => question.id === "r2")?.answer).toBeNull()
    }, [r2])
  })

  test("an answer quoting a fragment of a policy sentence escalates instead of passing as a rule", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: JSON.stringify({ decision: "answer", answer: "Two retries", rule: "settle one question", reason: "the policy settles it" }) }))
      expect(await itemFile(root, r2Item)).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
      expect(filedAt(await itemFile(root, r2Item), "decision", "reason")).toContain("in none of the rules it read")
      expect((await run(listTasks(root))).at(0)?.parked?.questions.find((question) => question.id === "r2")?.answer).toBeNull()
    }, [r2])
  })

  test("an answer that quotes only a word or two of a source escalates instead of passing as a rule", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: JSON.stringify({ decision: "answer", answer: "Two retries", rule: "twice", reason: "the intent says twice" }) }))
      expect(await itemFile(root, r2Item)).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
    }, [r2])
  })

  const turnsIntent = [
    "# Fix by name opens empty turns",
    "In the Agents tab a Fix step opens as a plain monospace log with no color.",
    "",
    "Fix: every step that ran a Pi session, Fix and any other agent step",
    "included, opens in the same Turns view as Agent, with Raw beside it showing the log as today. Each turn card carries its number.",
    ""
  ].join("\n")
  const turnsQuestion = { id: "r4", text: "fix-by-name-opens-empty-turns: should only the Fix step open in Turns, or every Pi step? Recommended: every Pi step." }
  const turnsItem = "orc-1.r4.2026-11-02T10_20_00_000Z"
  const turnsRule = "every step that ran a Pi session, Fix and any other agent step included, opens in the same Turns view as Agent, with Raw beside it showing the log as today."

  test("the orc-64 answer quoting a clause inside a longer intent line is answered, instead of escalated for not being a whole line", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [turnsQuestion.text]: JSON.stringify({ decision: "answer", answer: "Every Pi step opens in Turns", rule: turnsRule, reason: "the intent names every Pi step" }) }))
      expect(await itemFile(root, turnsItem)).toMatchObject({
        owner: "decider",
        decision: { kind: "answered", rule: { quote: turnsRule, source: "task orc-1" } },
        state: { kind: "closed", answer: { words: "Every Pi step opens in Turns" } }
      })
    }, [turnsQuestion], turnsIntent)
  })

  test("an answer on an invented rule worded like the orc-64 intent escalates, instead of being accepted", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [turnsQuestion.text]: JSON.stringify({ decision: "answer", answer: "Only Fix opens in Turns", rule: "only the Fix step opens in the same Turns view as Agent.", reason: "the intent names Fix" }) }))
      expect(await itemFile(root, turnsItem)).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
      expect(filedAt(await itemFile(root, turnsItem), "decision", "reason")).toContain("in none of the rules it read")
    }, [turnsQuestion], turnsIntent)
  })

  test("the owner's rules and the project's instructions reach the prompt labelled, and an answer on the owner's rule keeps its quote and file, instead of a free reason", async () => {
    const r4 = { id: "r4", text: "pnpm or npm?" }
    await withAskingTask(async (root) => {
      const home = join(root, "home")
      await mkdir(home)
      const rules = join(home, "orchestrator.md")
      await writeFile(rules, "# Rules\n\nuse pnpm when a project has pnpm-lock.yaml\n")
      await writeFile(join(root, "orc.md"), "Run bun run lint before a change is done.\n")
      await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { linux: "/home/a/orc" }, instructions: "orc.md" }] }))
      const heard: Array<DeciderRequest> = []
      const reply = JSON.stringify({ decision: "answer", answer: "pnpm", rule: "\"use pnpm when a project has pnpm-lock.yaml\"", reason: "the project has pnpm-lock.yaml" })
      await decide(root, replies({ [r4.text]: reply }, heard, home))
      expect(heard).toHaveLength(1)
      expect(heard[0]?.prompt).toContain("The owner's rules, from " + rules + ":\n\n# Rules\n\nuse pnpm when a project has pnpm-lock.yaml")
      expect(heard[0]?.prompt).toContain("The instructions of the project orc, from " + join(root, "orc.md") + ":\n\nRun bun run lint before a change is done.")
      expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({
        decision: { kind: "answered", reason: "the project has pnpm-lock.yaml", rule: { quote: "use pnpm when a project has pnpm-lock.yaml", source: rules } },
        state: { kind: "closed", answer: { words: "pnpm" } }
      })
    }, [r4])
  })

  test("a duplicate link to an unanswered question escalates instead of answering with nothing", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: escalate, [r3.text]: JSON.stringify({ decision: "duplicate", of: r2Item }) }))
      expect(await itemFile(root, r3Item)).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
      expect(filedAt(await itemFile(root, r3Item), "decision", "reason")).toContain("no answered question of this task")
    })
  })

  test("a duplicate link to an answered question gives that question's answer and names it, instead of a new answer", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: answer, [r3.text]: JSON.stringify({ decision: "duplicate", of: r2Item }) }))
      expect(await itemFile(root, r3Item)).toMatchObject({ owner: "decider", decision: { kind: "duplicate", of: r2Item }, state: { kind: "closed", answer: { words: "Two retries" } } })
      expect((await run(listTasks(root))).at(0)?.parked?.questions.find((question) => question.id === "r3")?.answer).toMatchObject({ words: "Two retries", by: "decider" })
    })
  })

  test("an ask back hands the worker the decider's question and leaves the item open, instead of closing it as answered", async () => {
    const ask1 = { id: "ask-1", text: "Which retry count should the upload use?" }
    const item = "orc-1.ask-1.2026-11-02T10_20_00_000Z"
    await withAskingTask(async (root) => {
      await decide(root, replies({ [ask1.text]: JSON.stringify({ decision: "ask-back", question: "Does the upload run in CI?" }) }))
      expect(await itemFile(root, item)).toMatchObject({ kind: "worker-question", owner: "decider", decision: { kind: "asked-back", question: "Does the upload run in CI?" }, state: { kind: "open" } })
      const stored = (await run(listTasks(root))).at(0)?.parked?.questions.find((question) => question.id === "ask-1")?.answer
      expect(stored).toMatchObject({ by: "asked-back" })
      expect(stored?.words).toContain("Does the upload run in CI?")
      expect(await run(attentionText(false, root))).toContain("(asked the worker back: Does the upload run in CI?)")
    }, [ask1])
  })

  test("a follow-up carries the asked-back exchange in its prompt, instead of asking without that context", async () => {
    const ask1 = { id: "ask-1", text: "Which retry count should the upload use?" }
    const ask2 = { id: "ask-2", text: "It runs in CI, should it retry twice?" }
    const asked2 = new Date(Date.now() + 60_000).toISOString()
    await withAskingTask(async (root) => {
      await decide(root, replies({ [ask1.text]: JSON.stringify({ decision: "ask-back", question: "Does the upload run in CI?" }) }))
      await run(askStartedTask(root, "orc-1", { asked: asked2, questions: [ask2] }))
      await run(routeTaskItems(root, await run(listTasks(root)), asked2))
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [ask2.text]: escalate }, heard))
      expect(heard).toHaveLength(1)
      expect(heard[0]?.prompt).toContain("Which retry count should the upload use?")
      expect(heard[0]?.prompt).toContain("Does the upload run in CI?")
    }, [ask1])
  })

  test("a settled follow-up closes the earlier asked-back item, instead of leaving it open with no owner", async () => {
    const ask1 = { id: "ask-1", text: "Which retry count should the upload use?" }
    const ask2 = { id: "ask-2", text: "It runs in CI, should it retry twice?" }
    const asked2 = new Date(Date.now() + 60_000).toISOString()
    const item1 = "orc-1.ask-1.2026-11-02T10_20_00_000Z"
    const item2 = "orc-1.ask-2." + asked2.replace(/[^A-Za-z0-9_-]/g, "_")
    await withAskingTask(async (root) => {
      await decide(root, replies({ [ask1.text]: JSON.stringify({ decision: "ask-back", question: "Does the upload run in CI?" }) }))
      await run(askStartedTask(root, "orc-1", { asked: asked2, questions: [ask2] }))
      await run(routeTaskItems(root, await run(listTasks(root)), asked2))
      await decide(root, replies({ [ask2.text]: answer }))
      expect((await run(openItems(root))).map((entry) => entry.id)).not.toContain(item1)
      expect(await itemFile(root, item1)).toMatchObject({ state: { kind: "closed" } })
      expect(await itemFile(root, item2)).toMatchObject({ state: { kind: "closed", answer: { words: "Two retries" } } })
    }, [ask1])
  })

  test("an ask back on a review question escalates instead of asking a run that cannot reply", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: JSON.stringify({ decision: "ask-back", question: "Does the upload run in CI?" }) }))
      expect(await itemFile(root, r2Item)).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
    }, [r2])
  })

  test("an overturned answer the run has not taken is the one the run receives, not the decider's", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: answer }))
      await run(answerTask(root, "orc-1", "r2=Three retries", "2099-01-01T00:00:00.000Z"))
      await run(routeTaskItems(root, await run(listTasks(root)), "2099-01-01T00:00:00.000Z"))
      const task = (await run(listTasks(root))).at(0)
      if (task === undefined) {
        throw new Error("the task is gone")
      }
      expect(answersFor(task, { asked, questions: [r2] }).map((question) => question.answer.words)).toEqual(["Three retries"])
      expect(task.parked?.questions.at(0)?.answer).toMatchObject({ words: "Three retries", overturned: { words: "Two retries", by: "decider" } })
      expect(correctionsDue(task)).toEqual([])
      expect(await itemFile(root, r2Item)).toMatchObject({ state: { kind: "closed", answer: { words: "Three retries" }, overturned: { words: "Two retries" } } })
      expect(await run(attentionText(false, root))).toContain("answered " + r2Item + ": Three retries (the captain replaced the decider's answer \"Two retries\")")
    }, [r2])
  })

  test("a late mark of the relayed decider words leaves the captain's answer unmarked and due, instead of marking words the run never got", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: answer }))
      await run(answerTask(root, "orc-1", "r2=Three retries", "2099-01-01T00:00:00.000Z"))
      await run(markAnswersRelayed(root, "orc-1", asked, [{ id: "r2", asked, words: "Two retries" }]))
      const task = (await run(listTasks(root))).at(0)
      if (task === undefined) {
        throw new Error("the task is gone")
      }
      expect(task.parked?.questions.at(0)?.answer).toMatchObject({ words: "Three retries", relayedTo: null })
      expect(correctionsDue(task).map((question) => [question.id, question.answer.words, question.answer.overturned.words])).toEqual([["r2", "Three retries", "Two retries"]])
    }, [r2])
  })

  test("an overturned answer the run already took is due to it as a correction, instead of standing unsent", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: answer }))
      await run(markAnswersRelayed(root, "orc-1", asked, [{ id: "r2", asked, words: "Two retries" }]))
      await run(answerTask(root, "orc-1", "r2=Three retries", "2099-01-01T00:00:00.000Z"))
      const task = (await run(listTasks(root))).at(0)
      if (task === undefined) {
        throw new Error("the task is gone")
      }
      expect(correctionsDue(task).map((question) => [question.id, question.answer.words, question.answer.overturned.words])).toEqual([["r2", "Three retries", "Two retries"]])
    }, [r2])
  })

  test("the captain's answer is never replaced by a second one, unlike a decider's", async () => {
    await withAskingTask(async (root) => {
      await run(answerTask(root, "orc-1", "r2=Two retries", "2026-11-02T10:22:00.000Z"))
      await assert.rejects(run(answerTask(root, "orc-1", "r2=Three retries", "2026-11-02T10:23:00.000Z")))
    })
  })

  test("a closed task refuses an overturn instead of rewriting an answer its run took", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: answer }))
      await run(closeStartedTask(root, "orc-1", "done", "the upload retries", { pr: null, report: null }, "2026-11-02T10:40:00.000Z"))
      await assert.rejects(run(answerTask(root, "orc-1", "r2=Three retries", "2099-01-01T00:00:00.000Z")))
      expect((await run(listTasks(root))).at(0)?.parked?.questions.at(0)?.answer).toMatchObject({ words: "Two retries" })
    }, [r2])
  })
})
