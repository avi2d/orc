import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { answerWaitFromEnv, waitForAnswers } from "../../packages/run/src/answer-wait"

const finding = (id: string, description: string) => ({ id, severity: "error", file: "", action: "ask-user", description })

const inTemp = async <A>(body: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-answer-wait-"))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("answerWaitFromEnv", () => {
  test("an unset or blank value waits thirty minutes instead of not waiting", () => {
    expect(Effect.runSync(answerWaitFromEnv(undefined))).toBe(1800)
    expect(Effect.runSync(answerWaitFromEnv("  "))).toBe(1800)
  })

  test("zero turns the wait off instead of being read as unset", () => {
    expect(Effect.runSync(answerWaitFromEnv("0"))).toBe(0)
  })

  test("a value that is not whole seconds is refused instead of read as a number", () => {
    for (const value of ["1.5", "-3", "10m", "abc"]) {
      expect(Effect.runSync(Effect.flip(answerWaitFromEnv(value))).message).toContain("ORC_ANSWER_WAIT_SECONDS is " + value)
    }
  })
})

describe("waitForAnswers", () => {
  test("an answer written during the wait comes back and both files are gone instead of left for the next gate", async () => {
    await inTemp(async (dir) => {
      const waiting = Effect.runPromise(waitForAnswers(dir, 30)([finding("r2", "changes product behavior")]).pipe(Effect.provide(BunServices.layer)))
      await Bun.sleep(300)
      const asking: unknown = JSON.parse(await Bun.file(join(dir, "asking.json")).text())
      expect(asking).toMatchObject({ questions: [{ id: "r2", text: "changes product behavior" }] })
      await writeFile(join(dir, "answers.json"), JSON.stringify([{ question: "other", answer: "ignored" }, { question: "r2", answer: "Keep it" }]))
      expect(await waiting).toEqual([{ question: "r2", answer: "Keep it" }])
      expect(await readdir(dir)).toEqual([])
    })
  }, 15_000)

  test("a wait that runs out returns no answer instead of waiting on", async () => {
    await inTemp(async (dir) => {
      const started = Date.now()
      const answers = await Effect.runPromise(waitForAnswers(dir, 1)([finding("r2", "x")]).pipe(Effect.provide(BunServices.layer)))
      expect(answers).toEqual([])
      expect(Date.now() - started).toBeLessThan(5000)
      expect(await readdir(dir)).toEqual([])
    })
  })
})
