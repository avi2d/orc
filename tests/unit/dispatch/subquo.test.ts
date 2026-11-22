import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { assessQuota, assessSubquo } from "../../../packages/run/src/widgets/beat/quota"
import { runQuotaCommand } from "../../../packages/run/src/widgets/beat/quota-command"
import { decodeSubquo } from "../../../packages/run/src/widgets/beat/subquo"

type Fixture = { readonly [key: string]: unknown; readonly accounts: ReadonlyArray<Record<string, unknown>> }

const isFixture = (value: unknown): value is Fixture =>
  typeof value === "object" && value !== null && "accounts" in value && Array.isArray(value.accounts)

const fixture = (): Fixture => {
  const parsed: unknown = JSON.parse(readFileSync(join(import.meta.dir, "../../fixtures/subquo/read.json"), "utf8"))
  if (!isFixture(parsed)) {
    throw new Error("the subquo fixture holds no accounts")
  }
  return parsed
}

const settings = (...names: ReadonlyArray<string>) => ({ command: ["subquo", "read", "--json"] as const, accounts: names.map((name) => ({ name })), floorPercent: 15 })

const now = Date.parse("2026-11-22T20:00:40.000Z")

const withAccount = (id: string, observation: object) => {
  const snapshot = fixture()
  return { ...snapshot, accounts: snapshot.accounts.map((entry) => entry["id"] === id ? { ...entry, observation } : entry) }
}

describe("assessSubquo on a subquo read --json snapshot", () => {
  test("account second is resolved and picked instead of unusable for want of an entry", () => {
    expect(assessSubquo(fixture(), settings("main", "second"), now)).toEqual({
      kind: "read",
      floorPercent: 15,
      accounts: [
        { account: "main", kind: "usable", remainingPercent: 41, resetsAt: "2026-11-27T09:00:00.000Z" },
        { account: "second", kind: "usable", remainingPercent: 74, resetsAt: "2026-11-28T12:00:00.000Z" }
      ],
      pick: "second"
    })
  })
  test("headroom is the smallest all-model window instead of the sum or the first window", () => {
    const reading = assessSubquo(fixture(), settings("main"), now)
    expect(reading.kind === "read" ? reading.accounts[0] : null).toMatchObject({ remainingPercent: 41 })
  })
  test("a model-scoped window does not limit the account instead of holding every job at its percent", () => {
    const reading = assessSubquo(fixture(), settings("main"), now)
    expect(reading.kind === "read" ? reading.pick : null).toBe("main")
  })
  test("a missing account is a parse error instead of an unusable account", () => {
    expect(decodeSubquo(fixture(), ["main", "third"], now)).toEqual({
      kind: "error",
      cause: "account-missing",
      reason: "the subquo snapshot names no account third, so its account list and the quota accounts differ"
    })
    expect(assessSubquo(fixture(), settings("main", "third"), now).kind).toBe("unread")
  })
  test("an unavailable account keeps subquo's code instead of being picked", () => {
    const reading = assessSubquo(fixture(), settings("codex-home"), now)
    expect(reading).toEqual({ kind: "read", floorPercent: 15, accounts: [{ account: "codex-home", kind: "unusable", reason: "subquo reads it unavailable: rate_limited" }], pick: null })
  })
  test("a stale reading is unusable instead of picked from its old percent", () => {
    const reading = assessSubquo(fixture(), settings("go"), now)
    expect(reading.kind === "read" ? reading.accounts : []).toEqual([{ account: "go", kind: "unusable", reason: "subquo's reading from 2026-11-22T19:51:00.000Z is stale: timeout" }])
  })
  test("a fresh reading past its validUntil is unusable instead of trusted at the time of use", () => {
    const reading = assessSubquo(fixture(), settings("second"), Date.parse("2026-11-22T20:02:05.000Z"))
    expect(reading.kind === "read" ? reading.pick : "unread").toBeNull()
  })
  test("an unknown percent is unusable instead of read as room", () => {
    const snapshot = withAccount("second", {
      status: "fresh",
      observedAt: "2026-11-22T20:00:05.000Z",
      source: "provider",
      validUntil: "2026-11-22T20:02:05.000Z",
      windows: [{ id: "weekly", scope: "all", percentLeft: null, resetsAt: null }]
    })
    const reading = assessSubquo(snapshot, settings("second"), now)
    expect(reading.kind === "read" ? reading.accounts : []).toEqual([{ account: "second", kind: "unusable", reason: "subquo reads an unknown percent or reset in the weekly window" }])
  })
  test("another snapshot version is a schema error instead of read as orc.quota.v1", () => {
    const read = decodeSubquo({ ...fixture(), version: "subquo.v2" }, ["main"], now)
    expect(read.kind === "error" ? [read.cause, read.reason] : []).toEqual(["schema", "the quota command printed no subquo.v1 snapshot: Expected \"subquo.v1\"\n  at [\"version\"]"])
  })
  test("percent above 100 is a schema error instead of room", () => {
    const snapshot = withAccount("second", {
      status: "fresh",
      observedAt: "2026-11-22T20:00:05.000Z",
      source: "provider",
      validUntil: "2026-11-22T20:02:05.000Z",
      windows: [{ id: "weekly", scope: "all", percentLeft: 140, resetsAt: "2026-11-28T12:00:00.000Z" }]
    })
    expect(decodeSubquo(snapshot, ["second"], now)).toMatchObject({ kind: "error", cause: "schema" })
  })
  test("an account named twice is a schema error instead of taking either reading", () => {
    const snapshot = fixture()
    expect(decodeSubquo({ ...snapshot, accounts: [...snapshot.accounts, snapshot.accounts[0]] }, ["main"], now)).toEqual({
      kind: "error",
      cause: "schema",
      reason: "the subquo snapshot names the account main twice"
    })
  })
})

describe("subquo figures against orc.quota.v1 figures", () => {
  const window = (percentLeft: number) => ({ id: "weekly", scope: "all", percentLeft, resetsAt: "2026-11-28T12:00:00.000Z" })
  const snapshotOf = (figures: ReadonlyArray<readonly [string, number]>) => ({
    version: "subquo.v1",
    writtenAt: "2026-11-22T20:00:30.000Z",
    accounts: figures.map(([id, percent]) => ({
      id,
      provider: "claude",
      observation: { status: "fresh", observedAt: "2026-11-22T20:00:00.000Z", source: "provider", validUntil: "2026-11-22T20:02:00.000Z", windows: [window(percent)] }
    }))
  })
  const orcDocumentOf = (figures: ReadonlyArray<readonly [string, number]>) => ({ schema: "orc.quota.v1", accounts: figures.map(([name, remainingPercent]) => ({ name, remainingPercent })) })
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]> = [
    ["the most room", [["main", 40], ["second", 80]]],
    ["a tie keeps the first listed", [["main", 50], ["second", 50]]],
    ["both below the floor", [["main", 10], ["second", 14]]],
    ["one at the floor", [["main", 15], ["second", 5]]],
    ["both empty", [["main", 0], ["second", 0]]]
  ]
  for (const [name, figures] of cases) {
    test("the same figures give the same floor and pick instead of a different spend order: " + name, () => {
      const before = assessQuota(orcDocumentOf(figures), settings("main", "second"))
      const after = assessSubquo(snapshotOf(figures), settings("main", "second"), now)
      const decisions = (reading: typeof before) => reading.kind === "read" ? [reading.floorPercent, reading.pick, reading.accounts.map((entry) => entry.kind)] : reading.reason
      expect(decisions(after)).toEqual(decisions(before))
    })
  }
})

describe("runQuotaCommand", () => {
  const run = (command: readonly [string, ...Array<string>]) => Effect.runPromise(runQuotaCommand(command).pipe(Effect.provide(BunServices.layer)))
  test("a command that is not installed names the missing command instead of a bare spawn error", async () => {
    expect(await run(["orc-no-such-subquo", "read", "--json"])).toEqual({ kind: "failed", cause: "command-missing", reason: "the quota command orc-no-such-subquo is not installed on PATH" })
  })
  test("a non-zero exit names the exit code instead of reading the output", async () => {
    expect(await run(["sh", "-c", "echo '{}'; exit 3"])).toEqual({ kind: "failed", cause: "exit", reason: "the quota command sh exited 3" })
  })
  test("output that is not JSON names no-json instead of a schema mismatch", async () => {
    expect(await run(["sh", "-c", "echo snapshot"])).toEqual({ kind: "failed", cause: "no-json", reason: "the quota command sh printed no JSON" })
  })
})
