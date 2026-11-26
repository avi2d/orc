import { expect, test } from "bun:test"
import { buildCards } from "../../../packages/herdr-app/src/agents"
import { lineWords, textParts } from "../../../packages/herdr-app/src/links"
import { type TaskDetail, infoRows } from "../../../packages/herdr-app/src/task"

const address = "https://github.com/avi2d/orc/pull/219"

const closed: TaskDetail = {
  id: "orc-219",
  title: "Show the full thread",
  kind: "ship",
  body: "",
  created: "2026-11-13T10:00:00.000Z",
  priority: null,
  parent: null,
  dependsOn: [],
  prState: "open",
  hold: null,
  parked: null,
  state: { status: "closed", account: "main", started: null, outcome: "done", pr: address, report: null, closedAt: "2026-11-13T12:00:00.000Z" }
}

test("draws the task panel's PR row with an open action instead of plain text", () => {
  const value = infoRows(closed, []).find((row) => row.label === "PR")?.value ?? ""
  expect(textParts(value)).toEqual([{ text: address, opens: address }, { text: " (open)", opens: null }])
})

test("draws a PR address inside a decision card's text with an open action instead of plain text", () => {
  const parts = textParts(`Approve PR #219 at ${address}.`)
  expect(parts).toEqual([{ text: "Approve PR #219 at ", opens: null }, { text: address, opens: address }, { text: ".", opens: null }])
})

test("opens exactly the address it shows instead of another one", () => {
  const text = `Merged https://github.com/o/r/pull/12 and ${address}/files after review`
  const parts = textParts(text)
  expect(parts.map((part) => part.text).join("")).toBe(text)
  expect(parts.filter((part) => part.opens !== null).map((part) => [part.text, part.opens])).toEqual([
    ["https://github.com/o/r/pull/12", "https://github.com/o/r/pull/12"],
    [address, address]
  ])
})

test("gives text with no PR address no open action instead of linking it", () => {
  expect(textParts("Reading the task")).toEqual([{ text: "Reading the task", opens: null }])
  expect(textParts("see https://github.com/avi2d/orc/issues/3")).toEqual([{ text: "see https://github.com/avi2d/orc/issues/3", opens: null }])
})

test("draws the Approve step's PR address with an open action instead of plain text", () => {
  const [card] = buildCards(
    { schema: "orc.runs.v1", runs: [{ id: "20261113-090000-aaaaaa", project: "/work/orc", branch: "orc/orc-219", status: "succeeded", prLink: address, title: "run", step: null, questions: 0, endReason: null, kind: null, delivery: null, worktree: null }] },
    { schema: "orc.backlog.v1", projects: null, tasks: [{ id: "orc-219", title: "t", project: "orc", kind: "ship", status: "closed", hold: null, parked: null, parkedOrigin: null, reason: null, prState: null }], merged: [] },
    [{
      key: "orc-219/pr", kind: "pr", task: closed.id, title: closed.title, who: "beat", asked: null, link: address,
      ask: { question: "Merge the PR?", context: address, options: [] }, recommendation: null,
      action: { kind: "merge", argv: ["merge", closed.id, "--basis", "captain-word"] }
    }]
  )
  const waiting = card.standing.status === "Awaiting you" ? card.standing.waiting : null
  expect(waiting?.on === "approval" ? textParts(waiting.item.link) : []).toEqual([{ text: address, opens: address }])
})

test("wraps a sentence with a link word by word instead of splitting it into blocks around the link", () => {
  const link = "https://github.com/avi2d/orc/pull/317"
  const sentence = `Done by a firstmate worker in ${link}; held until its parked child orc-78 is closed, then dropped`
  const words = lineWords(sentence)
  expect(words.map((word) => word.map((part) => part.text).join(""))).toEqual([
    "Done ", "by ", "a ", "firstmate ", "worker ", "in ", `${link}; `, "held ", "until ", "its ", "parked ", "child ", "orc-78 ", "is ", "closed, ", "then ", "dropped"
  ])
  expect(words[6]).toEqual([{ text: link, opens: link }, { text: "; ", opens: null }])
})
