import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { routeTaskItems } from "../../../packages/run/src/entities/attention/attention"
import { addTask, claimTask, listTasks, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { type AskDecider, DeciderUnheard, decideReviewQuestions, type DeciderRequest } from "../../../packages/run/src/features/decider/index"
import { neverDecidedReason } from "../../../packages/run/src/features/decider/decider-guard"
import { askStartedTask } from "../../../packages/run/src/entities/parked-runs/index"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const intent = "# Retry the upload\nRetry a failed upload twice, then give up.\n"

const spec = { title: "Retry the upload", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-11-02T10:00:00.000Z", body: intent }

const claim = { beat: "beat-1", machine: "linux", account: "main", takenAt: "2026-11-02T10:01:00.000Z" }

const asked = "2026-11-02T10:20:00.000Z"
const r2 = { id: "r2", text: "How many retries?" }
const r3 = { id: "r3", text: "Keep the old flag name?" }

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

describe("the decider guard", () => {
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
        decision: { kind: "escalated", reason: "orc never hands the decider a question about deleting, and this one says \"delete the old branch\"" },
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

  test("a question asking to delete a branch with unlanded work reaches the captain with no decider call, instead of being decided by the decider", async () => {
    const unlanded = { id: "r4", text: "May I delete the orc/orc-12 branch? It holds unlanded work that never reached main. Recommended: yes." }
    await withAskingTask(async (root) => {
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [unlanded.text]: answer }, heard))
      expect(heard).toEqual([])
      expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
      expect(filedAt(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z"), "decision", "reason")).toContain("deleting")
    }, [unlanded])
  })

  const codeQuestions = [
    {
      rejects: "escalated as deleting because it says Removing",
      text: "The new field silently accepts an older orc instead. The narrower form is `nullableString(record.value, \"from\", at)` as a required field, matching `model`. Removing the fallback changes compatibility with older orc builds, so confirm before removing it."
    },
    {
      rejects: "escalated as credentials because it says keys",
      text: "The projects file keys each checkout path separately (`checkouts: Record<machine, path>`), and the folder name need not equal the project name. Matching `run.project` against the printed checkout paths would make this exact."
    }
  ]

  for (const code of codeQuestions) {
    test("a code question reaches the decider, instead of being " + code.rejects, async () => {
      const question = { id: "r4", text: code.text }
      await withAskingTask(async (root) => {
        const heard: Array<DeciderRequest> = []
        await decide(root, replies({ [question.text]: answer }, heard))
        expect(heard).toHaveLength(1)
        expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({ decision: { kind: "answered" } })
      }, [question])
    })
  }

  test("code objects and record keys are not escalated as deleted work or credentials", () => {
    const questions = [
      "Should I remove the deprecated method?",
      "Should I remove the unused dependency?",
      "Should I drop the default value?",
      "Should I remove the dead code?",
      "Should I remove the console.log?",
      "Should I remove the duplicate export?",
      "Should I remove src/legacy?",
      "Should I rm -rf dist before building?",
      "Should the parser drop records with no id?",
      "Should the loader drop rows with empty names?",
      "Should the decoder discard data that fails the schema?",
      "Should the summary drop commits from bots?",
      "Should I remove logs from the test output?",
      "Should the Map key be a string?",
      "The Record key is path; ok?",
      "Should the cache store the key with each entry?",
      "Should both maps share the key?",
      "Should the index store the project key on each run?",
      "Should we expose the record key to the panel?",
      "Should the lexer issue a token at end of input?",
      "Should the parser store tokens in an array?"
    ]
    for (const question of questions) expect(neverDecidedReason(question)).toBeNull()
  })

  test("deleting listed work, handling secrets and choosing a site's look are not decided by the decider", () => {
    const questions = [
      "Should I delete the run for orc-12?",
      "Should I delete the run so the slot frees?",
      "Should I delete the run and its worktree?",
      "Should I delete the branch orc/orc-12?",
      "Should I delete orc-12?",
      "Should I run git branch -D old?",
      "Should I run git reset --hard?",
      "Should I rotate the token?",
      "Should I revoke the token?",
      "Should I leak the key?",
      "Should I regenerate the key?",
      "Should I add the npm token to CI?",
      "Should I store the GH_TOKEN in the repo?",
      "Should I change the .env file?",
      "Should the landing page look like the dark mock?",
      "How should the header look at mobile widths?"
    ]
    for (const question of questions) expect(neverDecidedReason(question)).not.toBeNull()
  })

  test("versions, panel lists, lookups, auth headers and a loop's cost are not escalated as deleting, a site's look, logins or spending", () => {
    const questions = [
      "Should I drop node-18 support?",
      "Should I remove the sha-256 fallback?",
      "Should I remove utf-8 handling?",
      "Should I remove the tasks list from the panel?",
      "Should the parser look up the project by checkout path?",
      "Should the auth header be optional in the test fixture?",
      "Should the cost of the loop matter?",
      "Should we spend more time on the slow test?",
      "Should the CLI offer a --json flag?",
      "Should the parser follow Postel's law?",
      "Should the lexer reject legal characters after a quote?"
    ]
    for (const question of questions) expect(neverDecidedReason(question)).toBeNull()
  })

  test("dropping runs, paying, logging in and legal pages are not decided by the decider", () => {
    const questions = [
      "Should the panel drop runs with no project?",
      "Should I remove orc-12 from the backlog?",
      "Should we pay for the larger runner?",
      "Is the hosting cost worth it?",
      "Will the bigger plan cost $20 a month?",
      "Should I log in to the npm account?",
      "Should the dashboard add OAuth sign in?",
      "Should the footer link the terms of service?",
      "Should the checkout page show the public offer?",
      "Is scraping that site legal?"
    ]
    for (const question of questions) expect(neverDecidedReason(question)).not.toBeNull()
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

})
