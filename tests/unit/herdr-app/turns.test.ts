import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { callMark, sessionTurns, turnHeader, type Turn } from "../../../packages/herdr-app/src/turns"

const recorded = await readFile(join(import.meta.dir, "../../fixtures/herdr-drawer/orc-chat-session.jsonl"), "utf8")

const turnsOf = (text: string): ReadonlyArray<Turn> => {
  const read = sessionTurns(text)
  if (read.kind === "refused") throw new Error(read.reason)
  return read.value
}

describe("the Turns view of a recorded orc chat session", () => {
  test("shows one turn per model reply, not one per session line", () => {
    expect(turnsOf(recorded)).toHaveLength(3)
  })

  test("heads each turn with that reply's own tokens, not the session total", () => {
    expect(turnsOf(recorded).map(turnHeader)).toEqual([
      "in 2 · out 213 · cache read 0 · cache write 8.6k",
      "in 2 · out 39 · cache read 8.6k · cache write 238",
      "in 2 · out 178 · cache read 8.9k · cache write 2.1k"
    ])
  })

  test("marks the refused orc_backlog_answer call ✗ and the answered orc_backlog call ✓", () => {
    const calls = turnsOf(recorded).flatMap((turn) => turn.calls.map((call) => [call.name, callMark(call.result)]))
    expect(calls).toEqual([["orc_backlog_answer", "✗"], ["orc_backlog", "✓"]])
  })

  test("waits for a half-written last line instead of refusing the whole file", () => {
    const cut = recorded.slice(0, recorded.trimEnd().lastIndexOf("\n") + 40)
    expect(turnsOf(cut)).toHaveLength(2)
  })
})

describe("the Turns view of a recorded run's Agent step session", () => {
  const session = readFile(join(import.meta.dir, "../../fixtures/herdr-agents/run-session.jsonl"), "utf8")

  test("marks the bash call Pi recorded as an error ✗, not ✓ like the calls beside it", async () => {
    const calls = turnsOf(await session).flatMap((turn) => turn.calls.map((call) => [call.name, callMark(call.result)]))
    expect(calls).toEqual([["read", "✓"], ["bash", "✗"], ["bash", "✓"]])
  })

  test("heads each turn with the tokens Pi recorded for it, not a running total", async () => {
    expect(turnsOf(await session).map(turnHeader)).toEqual([
      "in 2 · out 86 · cache read 2.0k · cache write 6.2k",
      "in 2 · out 110 · cache read 8.2k · cache write 1.4k",
      "in 2 · out 172 · cache read 9.6k · cache write 738"
    ])
  })
})
