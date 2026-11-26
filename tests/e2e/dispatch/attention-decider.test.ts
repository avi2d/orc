import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { orcOk, runnerTimeout, withFixture } from "../runner-helpers"

test("answering an attention item writes owner attribution instead of leaving the decider unknown", async () => {
  await withFixture(async (fixture) => {
    const dir = join(fixture.home, "backlog", "attention")
    const file = join(dir, "run-failure.json")
    await mkdir(dir, { recursive: true })
    await writeFile(file, JSON.stringify({
      kind: "run-died",
      task: "example-1",
      text: "The run stopped",
      asked: "2026-11-20T10:00:00Z",
      owner: "user",
      state: { kind: "open" }
    }))
    expect(await orcOk(fixture, ["attention", "answer", "run-failure", "Check the log before retrying"])).toBe("answered run-failure\n")
    const stored: unknown = JSON.parse(await readFile(file, "utf8"))
    expect(stored).toMatchObject({
      state: { kind: "closed", answer: { words: "Check the log before retrying", decider: "owner" } }
    })
  })
}, runnerTimeout)
