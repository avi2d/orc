import { expect, test } from "bun:test"
import { parseDiagramReply, type DiagramResult } from "../../packages/run/src/features/running-a-task/diagram-turn"
import { prBody, type PrBodyInput } from "../../packages/run/src/features/running-a-task/run-finish"

const twoFindings = [
  { id: "stale-cache", file: "src/cache.ts", line: 42, severity: "error", action: "Clear the cache on write.", description: "A write leaves the old value in the cache." },
  { id: "loose-type", file: "src/types.ts", line: null, severity: "warning", action: "Narrow the parameter to the three modes.", description: "The parameter accepts any string." }
] as const

const headed = (overrides: Partial<PrBodyInput> = {}): string =>
  prBody({
    why: "Serve reads from a cache.",
    taskText: "Do the thing.\n",
    subjects: ["Add the cache"],
    diagram: null,
    passed: ["lint"],
    review: { kind: "unfixed", findings: [] },
    ...overrides
  })

const headingOrder = (body: string): ReadonlyArray<string> =>
  body.split("\n").filter((line) => line.startsWith("## ")).map((line) => line.slice(3))

test("every heading sits in the same order rather than drifting between runs", () => {
  expect(headingOrder(headed())).toEqual(["Why", "What changed", "How it was checked"])
  expect(headingOrder(headed({ diagram: "flowchart LR\n  a --> b", review: { kind: "unfixed", findings: twoFindings } }))).toEqual([
    "Why",
    "What changed",
    "How it fits",
    "How it was checked",
    "Open review findings"
  ])
})

test("a body without a diagram or findings omits those headings rather than leaving them empty", () => {
  const body = headed()
  expect(body).not.toContain("## How it fits")
  expect(body).not.toContain("## Open review findings")
  expect(body).toContain("## Why\n\nServe reads from a cache.")
  expect(body).toContain("## What changed\n\n- Add the cache")
})

test("a diagram lands as a mermaid fence under How it fits rather than as plain text", () => {
  const body = headed({ diagram: "flowchart LR\n  task --> run" })
  expect(body).toContain("## How it fits\n\n```mermaid\nflowchart LR\n  task --> run\n```")
})

test("an empty branch says so in What changed rather than leaving the section blank", () => {
  expect(headed({ subjects: [] })).toContain("## What changed\n\nNo commits landed on the branch.")
})

test("passed checks are named and the beat line stays when no local check ran", () => {
  expect(headed()).toContain("orc opened this PR after lint passed, without no-mistakes.")
  expect(headed({ passed: [] })).toContain("orc opened this PR without local checks or no-mistakes. The orc beat reads the GitHub checks on the PR.")
})

test("a review with no findings says so in one line rather than leaving the body silent", () => {
  const body = headed()
  expect(body).toContain("## How it was checked\n\norc opened this PR after lint passed, without no-mistakes.\nThe review found nothing.\n")
  expect(body).not.toContain("## Open review findings")
})

test("open findings are counted under How it was checked and listed under their own heading", () => {
  const body = headed({ review: { kind: "unfixed", findings: twoFindings } })
  expect(body).toContain("The review left 2 findings open, listed below.")
  expect(body).toContain(
    "## Open review findings\n\n" +
      "- error `stale-cache` at `src/cache.ts:42`: A write leaves the old value in the cache. Action: Clear the cache on write.\n" +
      "- warning `loose-type` at `src/types.ts`: The parameter accepts any string. Action: Narrow the parameter to the three modes.\n"
  )
})

test("one open finding reads as singular rather than plural", () => {
  expect(headed({ review: { kind: "unfixed", findings: [twoFindings[0]] } })).toContain("The review left 1 finding open, listed below.")
})

test("a failed review turn is named rather than read as a review that found nothing", () => {
  const body = headed({ review: { kind: "failed" } })
  expect(body).toContain("The review turn failed, so this PR lists no review findings.")
  expect(body).not.toContain("The review found nothing.")
  expect(body).not.toContain("## Open review findings")
})

test("an id-and-file repeat names its match rather than claiming issue identity", () => {
  const left = [
    { finding: twoFindings[0], reason: { kind: "repeat", round: 2 } },
    { finding: twoFindings[1], reason: { kind: "below-round-2-bar" } },
    { finding: { ...twoFindings[0], id: "late-leak" }, reason: { kind: "round-limit" } }
  ] as const
  expect(headed({ review: { kind: "left", findings: left } })).toContain(
    "## Open review findings\n\n" +
      "- error `stale-cache` at `src/cache.ts:42`: A write leaves the old value in the cache. Action: Clear the cache on write.\n" +
      "  - Left because it has the same id and file as a finding the fixer received in round 2.\n" +
      "- warning `loose-type` at `src/types.ts`: The parameter accepts any string. Action: Narrow the parameter to the three modes.\n" +
      "  - Left because its severity is below the round 2 bar, which fixes only errors.\n" +
      "- error `late-leak` at `src/cache.ts:42`: A write leaves the old value in the cache. Action: Clear the cache on write.\n" +
      "  - Left because the round limit was reached: the review after fix round 2 reported it.\n"
  )
})

const mermaid = (chart: string): DiagramResult => ({ kind: "mermaid", chart })

test("no diagram answers none, so a wordy change keeps no empty diagram", () => {
  expect(parseDiagramReply("no diagram\n")).toEqual({ kind: "none" })
  expect(parseDiagramReply("No Diagram")).toEqual({ kind: "none" })
  expect(parseDiagramReply(null)).toEqual({ kind: "none" })
})

test("a mermaid fence parses to its chart rather than the fence", () => {
  expect(parseDiagramReply("```mermaid\nflowchart LR\n  task --> run\n```")).toEqual(mermaid("flowchart LR\n  task --> run"))
})

test("prose without a fence parses to none rather than guessing a diagram", () => {
  expect(parseDiagramReply("The change is too small for a picture.")).toEqual({ kind: "none" })
  expect(parseDiagramReply("```\nflowchart LR\n```")).toEqual({ kind: "none" })
  expect(parseDiagramReply("```mermaid\n```")).toEqual({ kind: "none" })
})
