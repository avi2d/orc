import { expect, test } from "bun:test"
import { buildCards } from "../../../packages/herdr-app/src/agents"
import { lineWords, textParts } from "../../../packages/herdr-app/src/links"
import type { InboxItem } from "../../../packages/herdr-app/src/inbox"
import { type TaskDetail, infoRows } from "../../../packages/herdr-app/src/task"
import { type Node, appAppearance, cx, node, nodes } from "./gpui-fakes"

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

const pull = "https://github.com/example/project/pull/461"
const run = "https://github.com/example/project/actions/runs/46077057199"
const job = `${run}/job/140772971862`
const otherJob = `${run}/job/140773513101`
const report = `${pull}: the check ci/e2e (1) ${job}, ci/checks ${otherJob} is red`

test("detects the pull request and both jobs in a Beat report without swallowing the colon or comma", () => {
  expect(textParts(report)).toEqual([
    { text: pull, opens: pull },
    { text: ": the check ci/e2e (1) ", opens: null },
    { text: job, opens: job },
    { text: ", ci/checks ", opens: null },
    { text: otherJob, opens: otherJob },
    { text: " is red", opens: null }
  ])
})

test("detects an Actions run without its sentence-ending period", () => {
  expect(textParts(`Run: ${run}.`)).toEqual([
    { text: "Run: ", opens: null }, { text: run, opens: run }, { text: ".", opens: null }
  ])
})

test("keeps ports, path suffixes, balanced parentheses, query punctuation, and fragments in the target", () => {
  const url = "http://example.org:8080/file(v2)?colors=blue,red&view=all#details"
  expect(textParts(`See (${url}).`)).toEqual([
    { text: "See (", opens: null }, { text: url, opens: url }, { text: ").", opens: null }
  ])
  const files = `${address}/files`
  expect(textParts(files)).toEqual([{ text: files, opens: files }])
})

test("drops trailing Markdown emphasis marks from the target instead of opening an address ending in them", () => {
  expect(textParts(`**${pull}**`)).toEqual([{ text: "**", opens: null }, { text: pull, opens: pull }, { text: "**", opens: null }])
  expect(textParts(`_${run}_, ~~${job}~~.`)).toEqual([
    { text: "_", opens: null }, { text: run, opens: run }, { text: "_, ~~", opens: null }, { text: job, opens: job }, { text: "~~.", opens: null }
  ])
})

test("does not offer to open plain text or a bare scheme", () => {
  const text = "Reading the task with no target at https://."
  expect(textParts(text)).toEqual([{ text, opens: null }])
})

const nativeLinks = (element: object | string): ReadonlyArray<Node> => {
  const view = typeof element === "string" ? undefined : nodes.get(element)
  if (view === undefined) return []
  return [...(view.calls.some((call) => call.name === "href") ? [view] : []), ...view.kids.flatMap(nativeLinks)]
}

const argument = (view: Node, call: string): unknown => view.calls.find(({ name }) => name === call)?.args[0]

const styled = (link: Node, state: "hover" | "focus"): Node => {
  const apply = argument(link, state)
  const style = node()
  if (typeof apply === "function") apply(style)
  const result = nodes.get(style)
  if (result === undefined) throw new Error("Missing link style")
  return result
}

test("passes exact report URLs to the native open action instead of plain text or punctuated targets", async () => {
  const { InboxAnswers } = await import("../../../packages/herdr-app/src/inbox-view")
  const { palette } = await import("../../../packages/herdr-app/src/palette")
  const item: InboxItem = {
    key: "example/report", task: "example", title: "Example", kind: "event", who: "beat", asked: null, recommendation: null,
    ask: { question: `The PR ${pull}`, context: `${report}. Run: ${run}.`, options: [] },
    action: { kind: "event", id: "example" }
  }
  const answers = new InboxAnswers(() => undefined)
  for (const view of [answers.item(palette(), item, () => undefined), answers.askCard(palette(), item, () => undefined)]) {
    expect(nativeLinks(view).map((link) => argument(link, "href"))).toEqual([pull, pull, job, otherJob, run])
  }
})

const channel = (color: string, at: number): number => {
  const value = Number.parseInt(color.slice(at, at + 2), 16) / 255
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

const luminance = (color: string): number => 0.2126 * channel(color, 1) + 0.7152 * channel(color, 3) + 0.0722 * channel(color, 5)

const contrast = (first: string, second: string): number => {
  const [a, b] = [luminance(first), luminance(second)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const colorOf = (view: Node, call: "text_color" | "bg"): string => {
  const color = argument(view, call)
  if (typeof color !== "string") throw new Error(`Missing ${call}`)
  return color
}

test("draws readable link colours in each appearance instead of a status colour or the dark blue on a light theme", async () => {
  const { linkedText } = await import("../../../packages/herdr-app/src/links-view")
  const { palette } = await import("../../../packages/herdr-app/src/palette")
  for (const look of [{ dark: true, background: "#282c34" }, { dark: false, background: "#fafafa" }]) {
    appAppearance.dark = look.dark
    try {
      const [link] = nativeLinks(linkedText("job", job))
      if (link === undefined) throw new Error("Missing job link")
      const rest = colorOf(link, "text_color")
      if (look.dark) expect(rest).toBe("#74ade8")
      const { working, blocked, done } = palette()
      expect([working, blocked, done]).not.toContain(rest)
      expect(contrast(rest, look.background)).toBeGreaterThanOrEqual(4.5)
      expect(link.calls.map(({ name }) => name)).toContain("underline")
      expect(link.calls.map(({ name }) => name)).toContain("cursor_pointer")
      expect(argument(link, "tab_stop")).toBe(true)
      const hover = colorOf(styled(link, "hover"), "text_color")
      expect(hover).not.toBe(rest)
      expect(contrast(hover, look.background)).toBeGreaterThanOrEqual(4.5)
      const focus = styled(link, "focus")
      expect(contrast(colorOf(focus, "text_color"), colorOf(focus, "bg"))).toBeGreaterThanOrEqual(4.5)
    } finally {
      appAppearance.dark = true
    }
  }
})

test("a pointer press does not leave the job link highlighted and tabbing back restores visible focus", async () => {
  const { linkedText } = await import("../../../packages/herdr-app/src/links-view")
  const jobLink = () => {
    const [link] = nativeLinks(linkedText("focus-job", job))
    if (link === undefined) throw new Error("Missing job link")
    return link
  }
  const press = jobLink().calls.find(({ name }) => name === "on_mouse_down")
  const onPress = press?.args[1]
  expect(press?.args[0]).toBe("left")
  if (typeof onPress !== "function") throw new Error("Missing pointer handler")
  onPress({ button: "left" }, cx)

  const pointerLink = jobLink()
  expect(argument(pointerLink, "focus")).toBeUndefined()
  expect(argument(pointerLink, "href")).toBe(job)
  expect(argument(pointerLink, "tab_stop")).toBe(true)

  const onTabRelease = argument(pointerLink, "on_key_up")
  if (typeof onTabRelease !== "function") throw new Error("Missing keyboard handler")
  onTabRelease({ key: "tab" }, cx)
  expect(argument(jobLink(), "focus")).toBeFunction()
})

test("draws the Approve step's PR address with an open action instead of plain text", () => {
  const [card] = buildCards(
    { schema: "orc.runs.v1", runs: [{ id: "20261113-090000-aaaaaa", project: "/work/orc", branch: "orc/orc-219", status: "succeeded", prLink: address, title: "run", step: null, questions: 0, endReason: null, kind: null, delivery: null, worktree: null }] },
    { schema: "orc.backlog.v1", projects: null, tasks: [{ id: "orc-219", title: "t", project: "orc", kind: "ship", status: "closed", hold: null, parked: null, parkedOrigin: null, retriedRun: null, reason: null, prState: null }], merged: [] },
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
