import { describe, expect, test } from "bun:test"
import { assessQuota, describeQuota } from "../../../packages/run/src/widgets/beat/quota"

const settings = (...names: ReadonlyArray<string>) => ({ command: ["quota-axi", "--full", "--json"] as const, accounts: names.map((name) => ({ name })), floorPercent: 15 })

const codex = {
  generatedAt: "2026-11-15T15:58:15.631Z",
  schemaVersion: 5,
  providers: [{
    provider: "codex",
    label: "Codex",
    account: { email: "user@example.com", accountId: "account-redacted" },
    windows: [
      { id: "weekly", label: "week", kind: "weekly", percentUsed: 70, resetsAt: "2026-11-15T19:43:54.000Z", windowSeconds: 604800, percentRemaining: 30 },
      { id: "code_review_weekly", label: "code review week", kind: "weekly", percentRemaining: 5, resetsAt: "2026-11-17T00:00:00.000Z" }
    ],
    state: { status: "fresh", stale: false, refreshedAt: "2026-11-15T15:58:15.630Z" },
    accountKeys: ["codex-home"],
    quotaSemantics: {
      status: "known",
      effectiveAvailability: [
        { scope: "all_models", status: "known", effectivePercentRemaining: 30, boundedBy: ["weekly"], limitingWindowIds: ["weekly"] },
        { scope: "code_review", status: "known", effectivePercentRemaining: 5, boundedBy: ["code_review_weekly"], limitingWindowIds: ["code_review_weekly"] }
      ]
    }
  }]
}

const opencodeGo = {
  generatedAt: "2026-11-15T15:58:16.208Z",
  schemaVersion: 6,
  providers: [{
    provider: "opencode-go",
    label: "OpenCode Go",
    windows: [
      { id: "rolling", label: "rolling", kind: "unknown", percentRemaining: 96, windowSeconds: 18000, resetsAt: "2026-11-15T16:39:47.000Z" },
      { id: "weekly", label: "weekly", kind: "weekly", percentRemaining: 28, windowSeconds: 604800, resetsAt: "2026-11-16T00:00:00.000Z" },
      { id: "monthly", label: "monthly", kind: "monthly", percentRemaining: 60, startsAt: "2026-11-08T10:59:08.000Z", resetsAt: "2026-12-08T10:59:08.000Z" }
    ],
    state: { status: "fresh", stale: false },
    quotaSemantics: {
      status: "known",
      effectiveAvailability: [
        { scope: "all_models", status: "known", effectivePercentRemaining: 28, boundedBy: ["rolling", "weekly", "monthly"], limitingWindowIds: ["weekly"] }
      ]
    },
    accountKey: "default",
    accountKeys: ["default"]
  }]
}

describe("assessQuota on a quota-axi document", () => {
  test("a Codex document reads the all_models percent and the reset of its limiting window", () => {
    const reading = assessQuota(codex, settings("codex-home"))
    expect(reading).toEqual({
      kind: "read",
      floorPercent: 15,
      accounts: [{ account: "codex-home", kind: "usable", remainingPercent: 30, resetsAt: "2026-11-15T19:43:54.000Z" }],
      pick: "codex-home"
    })
    expect(describeQuota(reading)).toBe("quota: codex-home 30% left until 2026-11-15T19:43:54.000Z, floor 15%: runs use codex-home")
  })
  test("an opencode-go document reads the weekly window that bounds it below the rolling and monthly ones", () => {
    expect(assessQuota(opencodeGo, settings("default"))).toEqual({
      kind: "read",
      floorPercent: 15,
      accounts: [{ account: "default", kind: "usable", remainingPercent: 28, resetsAt: "2026-11-16T00:00:00.000Z" }],
      pick: "default"
    })
  })
  test("an account key names the entry when the document holds more than one", () => {
    const both = { ...codex, providers: [...codex.providers, ...opencodeGo.providers] }
    const reading = assessQuota(both, settings("default", "codex-home"))
    expect(reading.kind === "read" ? reading.accounts.map((account) => account.kind === "usable" ? account.remainingPercent : -1) : []).toEqual([28, 30])
  })
  test("a document that names no window leaves the quota unread", () => {
    const empty = { ...codex, providers: [{ ...codex.providers[0], windows: [] }] }
    expect(assessQuota(empty, settings("main"))).toEqual({ kind: "unread", reason: "the quota-axi document names no window" })
  })
  test("an entry with no all_models percent cannot run and says why", () => {
    const stale = { ...codex, providers: [{ ...codex.providers[0], state: { status: "auth_required", stale: true }, quotaSemantics: { status: "unknown", effectiveAvailability: [] } }] }
    expect(assessQuota(stale, settings("codex-home"))).toEqual({
      kind: "read",
      floorPercent: 15,
      accounts: [{ account: "codex-home", kind: "unusable", reason: "quota-axi reads no all_models remaining percent for codex, its state is auth_required" }],
      pick: null
    })
  })
})
