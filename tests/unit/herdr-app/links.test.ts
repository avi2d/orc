import { expect, test } from "bun:test"
import { buildCards } from "../../../packages/herdr-app/src/agents"
import { lineWords, textParts } from "../../../packages/herdr-app/src/links"
import type { InboxItem } from "../../../packages/herdr-app/src/inbox"
import { type TaskDetail, infoRows } from "../../../packages/herdr-app/src/task"
import { type Node, appAppearance, click, cx, find, node, nodes, stopped } from "./gpui-fakes"

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
const inboxReport = {
  key: "example/report", task: "example", title: "Example", kind: "event", who: "beat", asked: null, recommendation: null,
  ask: { question: `The PR ${pull}`, context: `${report}. Run: ${run}.`, options: [] },
  action: { kind: "event", id: "example" }
} satisfies InboxItem

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
  const answers = new InboxAnswers(() => undefined)
  const t = palette()
  for (const view of [answers.item(t, inboxReport, () => undefined), answers.askCard(t, inboxReport, () => undefined)]) {
    expect(nativeLinks(view).map((link) => argument(link, "href"))).toEqual([pull, pull, job, otherJob, run])
  }
})

const clickThrough = (link: Node, parent: Node): void => {
  const before = stopped.length
  click(link)
  if (stopped.length === before) click(parent)
}

test("keeps linked answer rows and tiles clickable without picking the option when its link opens", async () => {
  const { InboxAnswers } = await import("../../../packages/herdr-app/src/inbox-view")
  const { optionView } = await import("../../../packages/herdr-app/src/ask-view")
  const { palette } = await import("../../../packages/herdr-app/src/palette")
  const option = { letter: "A", text: `Review ${job}.`, picture: null }
  const item = { ...inboxReport, ask: { ...inboxReport.ask, options: [option] } }
  const answers = new InboxAnswers(() => undefined)
  answers.sync(cx, [item])
  const t = palette()
  const row = answers.optionRow(t, item, option, 0, () => undefined)
  const parent = nodes.get(row)
  const rowLink = nativeLinks(row).at(0)
  if (parent === undefined || rowLink === undefined) throw new Error("Missing linked answer row")
  expect(argument(parent, "hover")).toBeFunction()
  expect(argument(rowLink, "href")).toBe(job)
  clickThrough(rowLink, parent)
  expect(answers.isPicked(item, option)).toBe(false)
  click(parent)
  expect(answers.isPicked(item, option)).toBe(true)

  let choices = 0
  const tile = optionView(t, "option-with-link", option, (shown) => shown.on_click(() => { choices++ }))
  const tileParent = find(tile, "option-with-link")
  const tileLink = nativeLinks(tile).at(0)
  if (tileParent === null || tileLink === undefined) throw new Error("Missing linked answer tile")
  expect(argument(tileLink, "href")).toBe(job)
  clickThrough(tileLink, tileParent)
  expect(choices).toBe(0)
  click(tileParent)
  expect(choices).toBe(1)
})

const channel = (color: string, at: number): number => {
  const value = Number.parseInt(color.slice(at, at + 2), 16) / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
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

const checkLinkContrast = (link: Node, surfaces: ReadonlyArray<string>): void => {
  const rest = colorOf(link, "text_color")
  const hover = colorOf(styled(link, "hover"), "text_color")
  const focus = styled(link, "focus")
  expect(hover).not.toBe(rest)
  for (const surface of surfaces) {
    expect(contrast(rest, surface)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(hover, surface)).toBeGreaterThanOrEqual(4.5)
  }
  expect(contrast(colorOf(focus, "text_color"), colorOf(focus, "bg"))).toBeGreaterThanOrEqual(4.5)
}

test("keeps dark cards readable in a light app and never uses the theme's status colours for links", async () => {
  const { InboxAnswers } = await import("../../../packages/herdr-app/src/inbox-view")
  const { linkedText } = await import("../../../packages/herdr-app/src/links-view")
  const { palette } = await import("../../../packages/herdr-app/src/palette")
  const answers = new InboxAnswers(() => undefined)
  for (const dark of [true, false]) {
    appAppearance.dark = dark
    try {
      const t = palette()
      const statusColors = [t.working, t.blocked, t.done]
      const themedLink = nativeLinks(linkedText("job", job)).at(0)
      if (themedLink === undefined) throw new Error("Missing themed job link")
      const card = answers.askCard(t, inboxReport, () => undefined)
      const cardNode = nodes.get(card)
      const cardLink = nativeLinks(card).find((link) => argument(link, "href") === job)
      if (cardNode === undefined || cardLink === undefined) throw new Error("Missing report card or job link")
      const cardSurface = colorOf(cardNode, "bg")
      expect(cardSurface).toBe("#1f1f22")
      checkLinkContrast(cardLink, [cardSurface])
      checkLinkContrast(themedLink, [t.background, t.surface, t.chrome, t.raised])
      expect(colorOf(cardLink, "text_color")).toBe("#74ade8")
      for (const link of [themedLink, cardLink]) {
        expect(statusColors).not.toContain(colorOf(link, "text_color"))
        expect(link.calls.map(({ name }) => name)).toContain("underline")
        expect(link.calls.map(({ name }) => name)).toContain("cursor_pointer")
        expect(argument(link, "tab_stop")).toBe(true)
      }
    } finally {
      appAppearance.dark = true
    }
  }
})

test("releasing Escape does not bring back the pointer highlight but tabbing back shows keyboard focus", async () => {
  const { linkedText } = await import("../../../packages/herdr-app/src/links-view")
  const jobLink = () => {
    const link = nativeLinks(linkedText("focus-job", job)).at(0)
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

  const onKeyRelease = argument(pointerLink, "on_key_up")
  if (typeof onKeyRelease !== "function") throw new Error("Missing keyboard handler")
  onKeyRelease({ key: "escape" }, cx)
  expect(argument(jobLink(), "focus")).toBeUndefined()
  onKeyRelease({ key: "tab" }, cx)
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
