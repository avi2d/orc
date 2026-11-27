import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { composedSessionQuotaReport, decodeQuota, overlaySubquo, type QuotaReport, type SnapshotFields, SnapshotReport, sessionQuotaView } from "@avi2dg/orc-schema"
import { fixture as fixtureText } from "../../lib/fixtures"
import { noOrcAccounts } from "../../lib/orc-quota"
import { ledgerOf } from "../../lib/quota-view-fixture"
import { quotaAxiJsonFor, quotaAxiRead } from "../../lib/quota-read"
import { type Guard, guardJson } from "../../../packages/herdr-app/src/guard"
import { type AccountRows, type QuotaWindow, type Subscriptions, type WindowRow, countdown, machineRows, machinesSnapshot, unreadLines, pastPace, runsOutAt, subscriptionRows, subscriptionsSnapshot } from "../../../packages/herdr-app/src/resources"

const fixture = await Bun.file(`${import.meta.dir}/../../fixtures/herdr-resources/two-machines.json`).text()

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour

const guarded = <A>(text: string, guard: Guard<A>): A => {
  const result = guardJson(text, guard)
  if (result.kind === "refused") throw new Error(result.reason)
  return result.value
}

const read = <A>(known: { readonly kind: "ok"; readonly value: A } | { readonly kind: "failed"; readonly reason: string }): A => {
  if (known.kind === "failed") throw new Error(known.reason)
  return known.value
}

const rowsOf = (text: string) => {
  const snapshot = guarded(text, machinesSnapshot)
  return machineRows(read(snapshot.machines), snapshot.queues)
}

const subscriptionsOf = (text: string): Subscriptions => read(guarded(text, subscriptionsSnapshot))

type QuotaStatus = SnapshotFields<"quota">["report"]["accounts"][number]["quota"]

const claudeUnread = (quota: QuotaStatus): string => {
  const document = Schema.decodeUnknownSync(SnapshotReport)(JSON.parse(fixture))
  const source = document.sources.quota
  if (source?.status !== "ok") throw new Error("the fixture holds no quota report")
  const report = {
    ...source.report,
    accounts: source.report.accounts.map((account) => account.title === "claude" ? { ...account, quota } : account),
    windows: source.report.windows.filter((window) => window.account.title !== "claude")
  }
  return JSON.stringify({ ...document, sources: { ...document.sources, quota: { ...source, report } } })
}

const windowsOf = (group: AccountRows | undefined): ReadonlyArray<WindowRow> => group?.kind === "windows" ? group.windows : []

const only = (windows: ReadonlyArray<QuotaWindow>): Subscriptions => ({ accounts: [], windows })

const remoteUnreachable = fixture.replace(
  /("name": "build-box",\s*"reading": )\{[\s\S]*?"gpu": null\s*\}\s*\}/,
  '$1{ "kind": "unreachable", "reason": "ssh timed out" }'
)

const week: QuotaWindow = {
  account: "claude",
  label: "week",
  startsAt: "2026-03-01T00:00:00.000Z",
  resetsAt: "2026-03-08T00:00:00.000Z",
  usedPoints: 50,
  leftPoints: 50,
  elapsedFraction: 0.25
}

describe("a countdown", () => {
  test("under a minute or past reads now, not 0h 0m or a negative time", () => {
    expect(countdown(0)).toBe("now")
    expect(countdown(59_999)).toBe("now")
    expect(countdown(-5 * minute)).toBe("now")
    expect(countdown(minute)).toBe("0h 1m")
  })

  test("at 59 minutes reads 0h 59m, not a rounded 1h", () => {
    expect(countdown(59 * minute + 59_000)).toBe("0h 59m")
  })

  test("at 23 hours reads 23h 0m, not 0d 23h", () => {
    expect(countdown(23 * hour)).toBe("23h 0m")
  })

  test("at 3 days reads 3d 0h, not 72h 0m", () => {
    expect(countdown(3 * day)).toBe("3d 0h")
    expect(countdown(3 * day + 17 * hour + 59 * minute)).toBe("3d 17h")
  })
})

describe("runs out", () => {
  test("is hidden when the pace empties the window only after the reset", () => {
    const slow = { ...week, usedPoints: 20, leftPoints: 80 }
    expect(runsOutAt(slow)).toBeNull()
    expect(windowsOf(subscriptionRows(only([slow]), Date.parse(week.startsAt) + 1.75 * day)[0])[0]?.runsOut).toBeNull()
  })

  test("is hidden once the reset has passed, not shown as a red now for a window that is gone", () => {
    const rows = subscriptionRows(only([week]), Date.parse(week.resetsAt) + hour)
    expect(windowsOf(rows[0])[0]).toMatchObject({ resets: "now", runsOut: null })
  })

  test("counts down to when the pace empties the window, not to the reset", () => {
    expect(runsOutAt(week)).toBe(Date.parse(week.startsAt) + 3.5 * day)
    expect(windowsOf(subscriptionRows(only([week]), Date.parse(week.startsAt) + 1.75 * day)[0])[0]).toMatchObject({ resets: "5d 6h", runsOut: "1d 18h" })
  })
})

describe("a bar", () => {
  test("is not red while used sits exactly at its notch", () => {
    expect(pastPace({ ...week, usedPoints: 25, leftPoints: 75 })).toBe(false)
  })

  test("is red once used passes its notch, and not before", () => {
    expect(pastPace({ ...week, usedPoints: 26, leftPoints: 74 })).toBe(true)
    expect(pastPace({ ...week, usedPoints: 24, leftPoints: 76 })).toBe(false)
  })
})

describe("the subscriptions table", () => {
  test("names an account once over all its windows, not on every row", () => {
    const groups = subscriptionRows(subscriptionsOf(fixture), Date.parse("2026-03-02T12:00:00.000Z"))
    expect(groups.map((group) => [group.account, windowsOf(group).map((row) => row.label)])).toEqual([
      ["claude", ["session", "week"]],
      ["codex", ["week"]]
    ])
    expect(windowsOf(groups[0])[0]).toMatchObject({ usedPercent: 60, red: true, resets: "3h 0m", runsOut: "1h 20m" })
  })

  test("keeps an account whose quota read failed, with the report's reason, instead of dropping its row", () => {
    const text = claudeUnread({ status: "unreachable", detail: "quota-axi read no claude usage" })
    expect(() => Schema.decodeUnknownSync(SnapshotReport)(JSON.parse(text))).not.toThrow()
    expect(subscriptionRows(subscriptionsOf(text), Date.parse("2026-03-02T12:00:00.000Z")).map((group) => group.kind === "unread" ? [group.account, group.reason] : [group.account])).toEqual([
      ["claude", "quota-axi read no claude usage"],
      ["codex"]
    ])
  })

  test("keeps an account the report reads as ok but holds no window for, instead of dropping its row", () => {
    const text = claudeUnread({ status: "ok" })
    expect(() => Schema.decodeUnknownSync(SnapshotReport)(JSON.parse(text))).not.toThrow()
    expect(subscriptionRows(subscriptionsOf(text), Date.parse("2026-03-02T12:00:00.000Z"))[0]).toEqual({
      kind: "unread", account: "claude", reason: "the quota report holds no window for it"
    })
  })

  test("refuses a window with no elapsedFraction rather than drawing a bar with no notch", () => {
    const text = fixture.replace('"elapsedFraction": 0.4,', "")
    expect(guardJson(text, subscriptionsSnapshot)).toEqual({ kind: "refused", reason: "sources.quota.report.windows[0].elapsedFraction is missing" })
  })
})

describe("the subscriptions table over a subquo reading", () => {
  const subquoRead: unknown = JSON.parse(fixtureText("subquo/fresh-read.json"))
  const readAt = DateTime.makeUnsafe("2026-11-27T09:35:00.000Z")
  const claudeMain = { provider: "claude", accountKey: "default", subquoId: "main" } as const

  const rowsOver = (quotaAxi: QuotaReport): ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]> | string]> => {
    const view = sessionQuotaView({
      quota: quotaAxiRead({ kind: "ok", capturedAt: readAt, value: overlaySubquo(quotaAxi, subquoRead, [claudeMain], readAt) }),
      orcQuota: noOrcAccounts(readAt),
      panes: undefined,
      processes: undefined,
      ledger: ledgerOf([]),
      sessions: [],
      sessionOfFile: new Map(),
      unmatched: [],
      now: readAt,
      timeZone: DateTime.zoneMakeNamedUnsafe("UTC")
    })
    const quota = { status: "ok", report: composedSessionQuotaReport(view, "mac") }
    const text = JSON.stringify({ schemaVersion: 1, generatedAt: DateTime.formatIso(readAt), machine: "mac", sources: { quota } })
    expect(() => Schema.decodeUnknownSync(SnapshotReport)(JSON.parse(text))).not.toThrow()
    return subscriptionRows(subscriptionsOf(text), DateTime.toEpochMillis(readAt)).map((group) =>
      [group.account, group.kind === "unread" ? group.reason : group.windows.map((row) => [row.label, row.usedPercent] as const)])
  }

  const claudeWeekOnly = (): QuotaReport => {
    const decoded = decodeQuota(quotaAxiJsonFor(["--provider", "claude"], fixtureText("quota-axi/full.json")))
    if (decoded.kind !== "ok") throw new Error(decoded.issue)
    const providers = decoded.value.providers.map((entry) =>
      "kind" in entry ? entry : { ...entry, windows: entry.windows.filter((window) => window.id !== "five_hour") })
    return { ...decoded.value, providers }
  }

  test("shows the week subquo read for a mapped Claude account, not an account with windows read as holding none", () => {
    expect(rowsOver(claudeWeekOnly())).toEqual([["claude", [["week", 30]]]])
  })

  test("shows the week of a Claude account only subquo reads, not an account with windows read as holding none", () => {
    expect(rowsOver({ generatedAt: readAt, providers: [], notSetUp: ["claude"] })).toEqual([["claude", [["week", 30]]]])
  })
})

describe("the machines table", () => {
  test("is read from a document the snapshot contract accepts", () => {
    expect(() => Schema.decodeUnknownSync(SnapshotReport)(JSON.parse(fixture))).not.toThrow()
    expect(() => Schema.decodeUnknownSync(SnapshotReport)(JSON.parse(remoteUnreachable))).not.toThrow()
  })

  test("shows both machines, not only this one", () => {
    expect(rowsOf(fixture)).toEqual([
      {
        name: "local",
        cores: { kind: "value", text: "10", alert: false },
        load: { kind: "value", text: "4.06", alert: false },
        memory: { kind: "value", text: "8 / 16 GiB", alert: false },
        disk: { kind: "value", text: "370 / 460 GiB", alert: false },
        runs: { kind: "value", text: "2", alert: false }
      },
      {
        name: "build-box",
        cores: { kind: "value", text: "16", alert: false },
        load: { kind: "value", text: "18.50", alert: true },
        memory: { kind: "value", text: "40 / 64 GiB", alert: false },
        disk: { kind: "value", text: "1200 / 1863 GiB", alert: false },
        runs: { kind: "value", text: "1", alert: false }
      }
    ])
  })

  test("marks an unreachable machine's cells unread, not zero", () => {
    const remote = rowsOf(remoteUnreachable)[1]
    expect(remote.load).toEqual({ kind: "failed", reason: "ssh timed out" })
    expect(remote.runs).toEqual({ kind: "value", text: "1", alert: false })
  })

  test("says an unreachable machine's reason once, not once for every cell", () => {
    expect(unreadLines(rowsOf(remoteUnreachable))).toEqual(["build-box: ssh timed out"])
  })

  test("names the unread cells when others on the machine read, not the whole machine", () => {
    const value = { kind: "value", text: "1", alert: false } as const
    const down = { kind: "failed", reason: "no df" } as const
    const row = { name: "local", cores: value, load: value, memory: down, disk: down, runs: value }
    expect(unreadLines([row])).toEqual(["local memory, disk: no df"])
  })

  test("refuses a running task with no group rather than counting it as an orc run", () => {
    const text = fixture.replace('"group": "orc",', "")
    expect(guardJson(text, machinesSnapshot)).toEqual({ kind: "refused", reason: "sources.queues.machines[0].pueue.value.running[0].group is missing" })
  })
})
