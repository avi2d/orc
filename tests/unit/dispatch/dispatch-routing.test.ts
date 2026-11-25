import { expect, test } from "bun:test"
import { Schema } from "effect"
import { DispatchRouting, resolveDispatch } from "../../../packages/run/src/shared/config/dispatch-routing"

const decode = Schema.decodeUnknownSync(DispatchRouting)

const routing = decode({
  rules: [
    { when: { kind: "ship", project: "editor", minEstimatedLines: 151 }, candidates: ["code/large", "review/opus"] },
    { when: { project: "editor" }, candidates: ["research/small"] }
  ],
  default: ["review/default"],
  tasks: {
    "editor-1": { estimatedLines: 151 },
    "editor-2": { estimatedLines: 150 },
    "editor-3": { estimatedLines: 151, model: "research/pinned" },
    "api-1": { estimatedLines: 151 }
  }
})

const task = { id: "editor-1", project: "editor", kind: "ship" } as const

const quota = {
  floorPercent: 20,
  accounts: [
    { name: "code-low", provider: "code", remainingPercent: 19 },
    { name: "code-at-floor", provider: "code", remainingPercent: 20 },
    { name: "review", provider: "review", remainingPercent: 40 },
    { name: "research", provider: "research", remainingPercent: 99 }
  ]
}

test("the first matching rule wins over a later match and an account with more quota", () => {
  expect(resolveDispatch(routing, task, quota)).toEqual({
    kind: "routed", account: "code-at-floor", models: { implementer: "code/large" }
  })
})

test("a size rule does not match a task at 150 lines, without an estimate, or of a different kind", () => {
  for (const other of [{ ...task, id: "editor-2" }, { ...task, id: "editor-4" }, { ...task, kind: "scout" as const }]) {
    expect(resolveDispatch(routing, other, quota)).toEqual({
      kind: "routed", account: "research", models: { implementer: "research/small" }
    })
  }
})

test("the default takes a task from another project instead of matching only kind and size", () => {
  expect(resolveDispatch(routing, { id: "api-1", project: "api", kind: "ship" }, quota)).toEqual({
    kind: "routed", account: "review", models: { implementer: "review/default" }
  })
})

test("a candidate below the quota floor falls through to the next candidate, not the next rule", () => {
  expect(resolveDispatch(routing, task, { ...quota, floorPercent: 21 })).toEqual({
    kind: "routed", account: "review", models: { implementer: "review/opus" }
  })
  expect(resolveDispatch(routing, task, { ...quota, floorPercent: 41 })).toEqual({
    kind: "waits", reason: "no account has room for the dispatch route"
  })
})

test("a task pin replaces a matching rule and never spills onto a different model when quota runs out", () => {
  const pinned = { ...task, id: "editor-3" }
  expect(resolveDispatch(routing, pinned, quota)).toEqual({
    kind: "routed", account: "research", models: { implementer: "research/pinned" }
  })
  expect(resolveDispatch(routing, pinned, { ...quota, floorPercent: 0, accounts: [
    ...quota.accounts.slice(0, 3), { name: "research", provider: "research", remainingPercent: 0 }
  ] })).toEqual({ kind: "waits", reason: "no account has room for the pinned model research/pinned" })
})

test("a design task uses Fable only with room on its account and falls back to Opus, not the general default", () => {
  const design = decode({
    rules: [{ when: { category: "design" }, candidates: [
      { models: { implementer: "claude/fable" }, account: "fable-access" },
      "claude/opus"
    ] }],
    default: ["code/worker"],
    tasks: { "editor-1": { category: "design" } }
  })
  const designQuota = (fable: number) => ({ floorPercent: 20, accounts: [
    { name: "fable-access", provider: "claude", remainingPercent: fable },
    { name: "standard", provider: "claude", remainingPercent: 70 },
    { name: "coder", provider: "code", remainingPercent: 90 }
  ] })
  expect(resolveDispatch(design, task, designQuota(20))).toEqual({
    kind: "routed", account: "fable-access", models: { implementer: "claude/fable" }
  })
  expect(resolveDispatch(design, task, designQuota(19))).toEqual({
    kind: "routed", account: "standard", models: { implementer: "claude/opus" }
  })
})

test("routing settings reject a candidate that would use a credential on another provider", () => {
  expect(() => decode({ rules: [], default: [{ models: { implementer: "code/large", reviewer: "review/opus" } }] }))
    .toThrow("the implementer, fixer, and reviewer must use one provider")
})
