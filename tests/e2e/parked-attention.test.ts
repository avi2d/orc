import { describe, expect, test } from "bun:test"
import { chmod, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { chatSession } from "../../packages/run/src/features/chat/chat-tools"
import { orcCommandVar } from "../../packages/run/src/features/chat/chat-run"
import { binPath, type Fixture, isRecord, orcOk, queuedArgs, runnerTimeout, withFixture } from "./runner-helpers"
import { askWhileRunning, backlogTaskOne, firstAsking, refuseOnQuestions, startOnLinux } from "./parked-helpers"

const loopQuestion = { id: "looping", text: "Pi failed bun run test 6 times in a row, so orc paused the run. Answer continue, with any guidance for Pi after it, to resume Pi, or stop to end the run." }

const workerAsk = {
  text: "Keep the old flag?\nA) Keep the old flag\nB) Drop the old flag (picture: docs/flag.png)",
  options: [
    { text: "Keep the old flag", outcome: "Existing scripts keep working." },
    { text: "Drop the old flag", outcome: "Existing scripts must change.", picture: "docs/flag.png" }
  ],
  recommendation: "Keep the old flag"
}

const openAttention = async (fixture: Fixture): Promise<unknown> => {
  const queue: unknown = JSON.parse(await orcOk(fixture, ["attention", "--json"]))
  return isRecord(queue) ? queue.items : null
}

describe("a parked run", () => {
  test("a waiting run's review question stays in orc attention after showing and leaves it only on its answer", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      await askWhileRunning(fixture)
      await orcOk(fixture, ["beat"])
      const asked = { kind: "review-question", task: "orc-1", text: "Keep the old flag?", asked: firstAsking.asked, owner: "user", overdue: true }
      expect(await openAttention(fixture)).toMatchObject([asked])
      const shown = await orcOk(fixture, ["attention"])
      expect(shown).toContain("orc-1")
      expect(shown).toContain("overdue")
      expect(await openAttention(fixture)).toMatchObject([asked])
      await orcOk(fixture, ["backlog", "answer", "orc-1", "r2=Keep it"])
      expect(await openAttention(fixture)).toEqual([])
      expect(await orcOk(fixture, ["attention"])).toContain("Decided by the owner:")
    })
  }, runnerTimeout)

  test("the chat thread tool lists the owner's answer and the agent's escalation under their own Decided by headings, rather than in one mixed list", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      await askWhileRunning(fixture)
      await orcOk(fixture, ["beat"])
      await orcOk(fixture, ["backlog", "answer", "orc-1", "r2=Keep it"])
      const session = chatSession({ ...process.env, ...fixture.env, [orcCommandVar]: JSON.stringify([process.execPath, binPath]) }, () => true, () => undefined)
      const thread = session.tools.find((tool) => tool.name === "orc_backlog_thread")
      const shown = thread === undefined ? "" : (await thread.execute("call-1", { id: "orc-1" })).content.map((block) => block.text).join("")
      expect(shown).toContain("Decided by the owner:\n")
      expect(shown).toContain("Decided by the agent:\n")
      const owner = shown.slice(shown.indexOf("Decided by the owner:"), shown.indexOf("Decided by the agent:"))
      const agent = shown.slice(shown.indexOf("Decided by the agent:"))
      expect(owner).toContain(": Keep it")
      expect(owner).not.toContain("escalated")
      expect(agent).toContain(": escalated: ")
      expect(agent).not.toContain("Keep it")
    })
  }, runnerTimeout)

  test("the beat hands the decider-owned question to the run without asking the person too", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      await writeFile(join(fixture.home, "config.json"), JSON.stringify({ providers: [], models: { decider: "acme/small" } }))
      const pi = join(fixture.dir, "bin", "pi")
      const reply = JSON.stringify({ decision: "answer", answer: "Keep it", rule: "When a question names a recommended option and the question is not on the never list, answer with that option even when it picks between product choices the intent leaves open or you are not sure.", reason: "the task keeps the old flag" })
      await writeFile(pi, "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + join(fixture.dir, "pi-args") + "\ncat > " + join(fixture.dir, "pi-prompt") + "\nprintf '%s\\n' '" + reply + "'\n")
      await chmod(pi, 0o755)
      const runDir = await askWhileRunning(fixture, { ...firstAsking, questions: [{ id: "r2", text: "Keep the old flag?\nRecommended: Keep it" }] })
      const beaten = await orcOk(fixture, ["beat"])
      expect(await openAttention(fixture)).toEqual([])
      expect(await backlogTaskOne(fixture)).toMatchObject({ parked: { questions: [{ id: "r2", answer: { words: "Keep it" } }] } })
      expect(beaten).toContain("handed r2 to the run of orc-1 on linux")
      expect(beaten).not.toContain("asking orc-1 on linux")
      expect(JSON.parse(await readFile(join(runDir, "answers.json"), "utf8"))).toEqual({ asking: firstAsking.asked, answers: [{ question: "r2", answer: "Keep it", decider: "agent" }] })
      expect((await readFile(join(fixture.dir, "pi-args"), "utf8")).split("\n")).toEqual(expect.arrayContaining(["--no-tools", "--model", "acme/small", "--system-prompt"]))
      expect(await readFile(join(fixture.dir, "pi-prompt"), "utf8")).toContain("Keep the old flag?")
    })
  }, runnerTimeout)

  test("with no decider model the beat escalates a question to the user with the reason, instead of leaving it with no one", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      await askWhileRunning(fixture)
      await orcOk(fixture, ["beat"])
      expect(await openAttention(fixture)).toMatchObject([{ owner: "user", decision: { kind: "escalated", reason: expect.stringContaining("names no models.decider") } }])
    })
  }, runnerTimeout)

  test("a parked run's questions each wait in orc attention, and one answer closes only its own item", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      await refuseOnQuestions(fixture)
      await orcOk(fixture, ["beat"])
      expect(await openAttention(fixture)).toMatchObject([{ task: "orc-1", text: "Which retries are allowed?" }, { task: "orc-1", text: "No text was supplied for question-5. Check the run before answering." }])
      await orcOk(fixture, ["backlog", "answer", "orc-1", "question-4=Two retries"])
      expect(await openAttention(fixture)).toMatchObject([{ task: "orc-1", text: "No text was supplied for question-5. Check the run before answering." }])
    })
  }, runnerTimeout)

  test("a question asked again after its answer opens a new item instead of staying closed", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      const runDir = await askWhileRunning(fixture)
      await orcOk(fixture, ["beat"])
      await orcOk(fixture, ["backlog", "answer", "orc-1", "r2=Keep it"])
      await orcOk(fixture, ["beat"])
      await writeFile(join(runDir, "asking.json"), JSON.stringify({ ...firstAsking, asked: "2026-11-02T11:20:00.000Z", until: "2026-11-02T11:50:00.000Z" }))
      await orcOk(fixture, ["beat"])
      expect(await openAttention(fixture)).toMatchObject([{ task: "orc-1", asked: "2026-11-02T11:20:00.000Z" }])
    })
  }, runnerTimeout)

  test("a run paused on a looping command parks for the captain's continue or stop, without handing it to the decider", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      await writeFile(join(fixture.home, "config.json"), JSON.stringify({ providers: [], models: { decider: "acme/small" } }))
      const pi = join(fixture.dir, "bin", "pi")
      await writeFile(pi, "#!/bin/sh\ntouch " + join(fixture.dir, "decider-asked") + "\nprintf '%s\\n' '" + JSON.stringify({ decision: "answer", answer: "continue", rule: "With a body that holds", reason: "keep going" }) + "'\n")
      await chmod(pi, 0o755)
      await refuseOnQuestions(fixture, [loopQuestion], "implement")
      expect(await orcOk(fixture, ["beat"])).toContain("parked orc-1 on orc/orc-1 for the captain's answer to looping")
      expect(await openAttention(fixture)).toMatchObject([{ kind: "review-question", task: "orc-1", text: loopQuestion.text, owner: "user" }])
      expect(await readFile(join(fixture.dir, "decider-asked"), "utf8").catch(() => null)).toBeNull()
      expect(await orcOk(fixture, ["backlog", "answer", "orc-1", "looping=continue, run one test file at a time"])).toBe("answered looping on orc-1, so the beat resumes it on orc/orc-1\n")
      expect(await orcOk(fixture, ["beat"])).toContain("started orc-1")
      const added = await queuedArgs(fixture)
      expect(added).toEqual(expect.arrayContaining(["--answer", "looping=continue, run one test file at a time"]))
    })
  }, runnerTimeout)

  test("a running run's third failure of one command asks the person in orc attention, and the item leaves once the command stops failing", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      const runDir = await askWhileRunning(fixture)
      await rm(join(runDir, "asking.json"))
      await writeFile(join(runDir, "agent.log"), "still running\n")
      await writeFile(join(runDir, "failing.json"), JSON.stringify({ label: "bun run test", since: "2026-11-02T10:10:00.000Z" }))
      await orcOk(fixture, ["beat"])
      expect(await openAttention(fixture)).toEqual([expect.objectContaining({
        kind: "failing-command",
        task: "orc-1",
        text: expect.stringContaining("Pi failed bun run test 3 times in a row"),
        asked: "2026-11-02T10:10:00.000Z",
        owner: "user"
      })])
      expect(await orcOk(fixture, ["attention"])).toContain("Pi failed bun run test 3 times in a row")
      await orcOk(fixture, ["beat"])
      expect(await openAttention(fixture)).toHaveLength(1)
      await rm(join(runDir, "failing.json"))
      await orcOk(fixture, ["beat"])
      expect(await openAttention(fixture)).toEqual([])
    })
  }, runnerTimeout)

  test("a worker's mid-run ask shows in orc attention as a worker-question with its options, instead of a bare review question", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      await askWhileRunning(fixture, { ...firstAsking, questions: [{ id: "ask-1", text: workerAsk.text, options: workerAsk.options, recommendation: workerAsk.recommendation }] })
      await orcOk(fixture, ["beat"])
      expect(await openAttention(fixture)).toMatchObject([{ kind: "worker-question", task: "orc-1", text: workerAsk.text, options: workerAsk.options, recommendation: workerAsk.recommendation, asked: firstAsking.asked }])
    })
  }, runnerTimeout)

  test("a worker's answered ask is handed to its run and the thread marks it delivered, instead of leaving it only answered", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      const runDir = await askWhileRunning(fixture, { ...firstAsking, questions: [{ id: "ask-1", text: workerAsk.text, options: workerAsk.options, recommendation: workerAsk.recommendation }] })
      await orcOk(fixture, ["beat"])
      expect(await openAttention(fixture)).toMatchObject([{ kind: "worker-question", options: workerAsk.options, recommendation: workerAsk.recommendation }])
      await orcOk(fixture, ["backlog", "answer", "orc-1", "ask-1=B"])
      expect(await orcOk(fixture, ["beat"])).toContain("handed ask-1 to the run of orc-1 on linux")
      expect(JSON.parse(await readFile(join(runDir, "answers.json"), "utf8"))).toEqual({ asking: firstAsking.asked, answers: [{ question: "ask-1", answer: "B", decider: "owner" }] })
      const thread: unknown = JSON.parse(await orcOk(fixture, ["backlog", "thread", "orc-1", "--json"]))
      const entries = isRecord(thread) && Array.isArray(thread.entries) ? thread.entries : []
      expect(entries.filter((entry) => isRecord(entry) && entry.kind !== "decision")).toMatchObject([
        { kind: "question", who: "worker", text: workerAsk.text },
        { kind: "answer", text: "B" },
        { kind: "delivered", who: "beat" }
      ])
    })
  }, runnerTimeout)

  test("a run stopped on an unanswered worker ask parks on its branch and its answer resumes it there, instead of closing failed", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      await refuseOnQuestions(fixture, [{ id: "ask-1", text: workerAsk.text }], "implement")
      expect(await orcOk(fixture, ["beat"])).toContain("parked orc-1 on orc/orc-1 for the")
      expect(await openAttention(fixture)).toMatchObject([{ kind: "worker-question", task: "orc-1", text: workerAsk.text }])
      expect(await orcOk(fixture, ["backlog", "answer", "orc-1", "ask-1=B"])).toBe("answered ask-1 on orc-1, so the beat resumes it on orc/orc-1\n")
      expect(await orcOk(fixture, ["beat"])).toContain("started orc-1")
      const added = await queuedArgs(fixture)
      expect(added).toEqual(expect.arrayContaining(["--answer", "ask-1=B", "--branch", "orc/orc-1"]))
    })
  }, runnerTimeout)
})
