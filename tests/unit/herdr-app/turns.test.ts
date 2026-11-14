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

  test("puts the typed message on the first turn only, not on the replies after a call", () => {
    expect(turnsOf(recorded).map((turn) => turn.prompt)).toEqual([
      "Answer the hold on task garden-99 with the word blue using orc_backlog_answer, then list the backlog with orc_backlog. Keep the reply to two sentences.",
      null,
      null
    ])
  })

  test("waits for a half-written last line instead of refusing the whole file", () => {
    const cut = recorded.slice(0, recorded.trimEnd().lastIndexOf("\n") + 40)
    expect(turnsOf(cut)).toHaveLength(2)
  })
})
