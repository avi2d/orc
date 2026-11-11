import { describe, expect, test } from "bun:test"
import {
  ancestry,
  insideSlot,
  insideThrough,
  parseProcessTable,
  unwrapSlotCommand
} from "../../../packages/run/src/dispatch/heavy-process-tree"

const waiter = (pid: number, call: string): string =>
  "sh -c 'o=$1; shift; \"$@\" & c=$!; wait \"$c\"' orc-heavy-wait " + String(pid) + " " + call

describe("parseProcessTable", () => {
  test("the ps header and padded columns read as rows with one-spaced commands instead of shifted fields", () => {
    const table = parseProcessTable("  PID  PPID COMMAND\n   10     1 /bin/sh   /h/bin/bun  test x\n    1     0 init\n")
    expect([...table.entries()]).toEqual([
      [10, { ppid: 1, command: "/bin/sh /h/bin/bun test x" }],
      [1, { ppid: 0, command: "init" }]
    ])
  })

  test("a repeated pid keeps its first row instead of the last", () => {
    expect(parseProcessTable("5 1 first\n5 2 second\n").get(5)).toEqual({ ppid: 1, command: "first" })
  })
})

describe("ancestry", () => {
  test("the walk stops at a parent of pid 0 instead of looking it up", () => {
    expect(ancestry(parseProcessTable("3 2 c\n2 1 b\n1 0 init\n"), 3)).toEqual(["c", "b", "init"])
  })

  test("a parent missing from the table ends the walk with an empty entry instead of a guessed command", () => {
    expect(ancestry(parseProcessTable("3 2 c\n"), 3)).toEqual(["c", ""])
  })

  test("a parent cycle ends the walk instead of spinning", () => {
    expect(ancestry(parseProcessTable("3 4 c\n4 3 d\n"), 3)).toEqual(["c", "d"])
  })
})

describe("unwrapSlotCommand", () => {
  test("a waiter command unwraps to the real call instead of keeping the waiter, its pid and the priority wrapper", () => {
    expect(unwrapSlotCommand(waiter(99, "taskpolicy -c utility /r/bun test x"))).toBe("/r/bun test x")
    expect(unwrapSlotCommand("/r/bun test x")).toBe("/r/bun test x")
  })
})

describe("insideSlot", () => {
  const standin = "/bin/sh /h/bin/bun test x"

  test("a call under the real tool of a queued task is inside the slot instead of queuing behind it", () => {
    const chain = [standin, "/r/bun test x", waiter(99, "/r/bun test x"), "pueued", "init"]
    expect(insideSlot([waiter(99, "/r/bun test x")], chain)).toBe(true)
  })

  test("an ancestor running a queued command as a sh -c script is inside the slot instead of needing an exact match", () => {
    expect(insideSlot([waiter(98, "bun run build")], [standin, "sh -c bun run build", "init"])).toBe(true)
  })

  test("a task pueue runs without the stand-in waiter holds no slot instead of matching its ancestors", () => {
    expect(insideSlot(["bun run build"], [standin, "sh -c bun run build", "/usr/bin/pueued", "init"])).toBe(false)
  })

  test("a stand-in that only resembles a queued command queues instead of trusting the match without a pueue ancestor", () => {
    expect(insideSlot([waiter(98, "bun test x")], [standin, "bash", "init"])).toBe(false)
    expect(insideSlot([waiter(98, "bun test x")], [standin, "/usr/bin/pueued", "init"])).toBe(true)
  })

  test("a slot that no ancestor runs queues instead of running at once", () => {
    expect(insideSlot([waiter(98, "cargo test")], [standin, "/r/bun test x", "init"])).toBe(false)
    expect(insideSlot([], [standin, "/r/bun test x", "init"])).toBe(false)
  })

  test("a walk that loses a parent queues instead of trusting the match before it", () => {
    expect(insideSlot([waiter(99, "/r/bun test x")], [standin, "/r/bun test x", ""])).toBe(false)
  })
})

describe("insideThrough", () => {
  const through = ["winbox-heavy", "run", "--"]
  const standin = "/bin/sh /h/bin/bun test"

  test("a call under the holder, a holder script or the through shell runs at once instead of queuing twice", () => {
    expect(insideThrough(through, [standin, "/f/winbox-heavy run -- /h/bin/bun test"])).toBe(true)
    expect(insideThrough(through, [standin, "/usr/bin/bun /f/winbox-heavy.ts run -- /h/bin/bun test"])).toBe(true)
    expect(insideThrough(through, [standin, "sh /f/winbox-heavy.sh run -- /h/bin/bun test"])).toBe(true)
    expect(insideThrough(through, [standin, 'sh -c "$@"; exit "$?" orc-heavy-through winbox-heavy run -- /f/bun test'])).toBe(true)
  })

  test("a shell script that only mentions the through words reaches the holder instead of running outside the limit", () => {
    expect(insideThrough(through, [standin, "sh -c winbox-heavy run -- true; bun test", "init"])).toBe(false)
  })

  test("the holder run with other words reaches the holder instead of counting as the held slot", () => {
    expect(insideThrough(through, [standin, "/f/winbox-heavy status", "init"])).toBe(false)
  })

  test("a through word with a space matches the split words instead of one word", () => {
    expect(insideThrough(["winbox-heavy", "run", "it's one"], [standin, "winbox-heavy run it's one /f/bun test"])).toBe(true)
  })
})
