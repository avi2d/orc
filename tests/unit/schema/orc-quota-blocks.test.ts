import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { decodeOrcQuota, decodeQuota, type OrcQuota, type QuotaBlock, quotaBlocks, type Reading, sessionQuotaView } from "@avi2dg/orc-schema";
import { fixture } from "../../lib/fixtures";
import { type OrcQuotaFixture, orcQuotaOf, orcQuotaReading } from "../../lib/orc-quota";
import { quotaAxiRead } from "../../lib/quota-read";
import { ledgerOf } from "../../lib/quota-view-fixture";

const now = DateTime.makeUnsafe("2026-11-24T18:46:36Z");

const blocksWith = (orcQuota: Reading<OrcQuota>): ReadonlyArray<QuotaBlock> => {
  const quota = decodeQuota(fixture("quota-axi/full.json"));
  if (quota.kind !== "ok") throw new Error("the fixtures do not decode");
  return quotaBlocks(quotaAxiRead({ ...quota, capturedAt: now }), orcQuota, now);
};

const accountBlocks = (name: OrcQuotaFixture): ReadonlyArray<QuotaBlock> =>
  blocksWith(orcQuotaOf(name, now)).filter((block) => block.title.startsWith("account"));

describe("quotaBlocks over the accounts orc quota --json prints", () => {
  test("does not show bare claude when Subquo names only main and quota-axi keys it default", () => {
    expect(blocksWith(orcQuotaOf("main", now))[0]?.title).toBe("claude main");
  });

  test.each(["main", "second-login-expired"] as const)("does not give two Claude rows the sole Orc account's name with %s", (name) => {
    const quota = decodeQuota(JSON.stringify({
      schemaVersion: 5,
      generatedAt: DateTime.formatIso(now),
      providers: ["default", "second"].map((accountKey) => ({
        provider: "claude",
        accountKey,
        accountKeys: [accountKey],
        windows: [],
        state: { status: "fresh", stale: false },
      })),
    }));
    if (quota.kind !== "ok") throw new Error("the two-account report does not decode");
    const read = quotaAxiRead({ ...quota, capturedAt: now });
    const orcQuota = orcQuotaOf(name, now);
    expect(quotaBlocks(read, orcQuota, now)
      .filter((block) => block.provider === "claude" && block.body.kind === "live")
      .map((block) => block.title)).toEqual(["claude", "claude second"]);
    const session = sessionQuotaView({
      quota: read,
      orcQuota,
      panes: undefined,
      processes: undefined,
      ledger: ledgerOf([]),
      sessions: [],
      sessionOfFile: new Map(),
      unmatched: [],
      now,
      timeZone: DateTime.zoneMakeNamedUnsafe("UTC"),
    });
    expect(session.accounts.map((account) => account.title)).toEqual(["claude", "claude second"]);
  });

  test("does not lend a configured Claude account's name to an unmatched native row", () => {
    const quota = decodeQuota(fixture("quota-axi/full.json"));
    if (quota.kind !== "ok") throw new Error("the quota fixture does not decode");
    const read = { ...quotaAxiRead({ ...quota, capturedAt: now }), accounts: [{ name: "main", read: undefined }] };
    const orcQuota = orcQuotaOf("main", now);
    expect(quotaBlocks(read, orcQuota, now).filter((block) => block.provider === "claude").map((block) => block.title))
      .toEqual(["claude", "claude main", "account main"]);
    const session = sessionQuotaView({
      quota: read,
      orcQuota,
      panes: undefined,
      processes: undefined,
      ledger: ledgerOf([]),
      sessions: [],
      sessionOfFile: new Map(),
      unmatched: [],
      now,
      timeZone: DateTime.zoneMakeNamedUnsafe("UTC"),
    });
    expect(session.accounts.map((account) => account.title)).toEqual(["claude", "claude main"]);
  });

  test("puts one account block per account between live claude and codex without guessing the login", () => {
    expect(blocksWith(orcQuotaOf("main-second", now)).map((block) => block.title)).toEqual([
      "claude",
      "account main",
      "account second",
      "codex",
      "opencode-go",
    ]);
  });

  test("marks the picked account next and an account under the 20% floor under-floor, not spare at 12%", () => {
    expect(accountBlocks("main-second").map((block) => block.body)).toEqual([
      { kind: "account", percentLeft: 77, resetsAt: DateTime.makeUnsafe("2026-12-01T04:00:00.080Z"), standing: "next", floorPercent: 20 },
      { kind: "account", percentLeft: 12, resetsAt: DateTime.makeUnsafe("2026-11-24T21:00:00.000Z"), standing: "under-floor", floorPercent: 20 },
    ]);
  });

  test("marks an unpicked account at 45% over the 20% floor spare, not under-floor", () => {
    expect(accountBlocks("second-spare").map((block) => block.body.kind === "account" && block.body.standing)).toEqual(["next", "spare"]);
  });

  test("measures the floor orc quota reports, so 73% sits under a 75% floor rather than over the default 20%", () => {
    expect(accountBlocks("codex-under-floor").map((block) => block.body.kind === "account" && block.body.standing)).toEqual(["next", "under-floor"]);
  });

  test("marks an account with no room left used-up, not under a floor of 0%", () => {
    const empty = JSON.stringify({ kind: "read", floorPercent: 0, accounts: [{ account: "second", kind: "usable", remainingPercent: 0 }], pick: null });
    const blocks = blocksWith(orcQuotaReading(empty, now)).filter((block) => block.title.startsWith("account"));
    expect(blocks.map((block) => block.body.kind === "account" && block.body.standing)).toEqual(["used-up"]);
  });

  test("keeps an unusable account's reason, and an account read without a reset time carries none", () => {
    expect(accountBlocks("second-unusable").map((block) => block.body)).toEqual([
      { kind: "account", percentLeft: 64, resetsAt: null, standing: "next", floorPercent: 20 },
      { kind: "unusable", reason: "its login expired, so sign in to second again" },
    ]);
  });

  test.each([
    ["command-missing", "command-missing", "the quota command subquo-not-here is not installed on PATH"],
    ["second-missing", "account-missing", "the subquo snapshot names no account second, so its account list and the quota accounts differ"],
  ] as const)("draws one accounts block for the %s unread cause, not an empty panel", (name, cause, reason) => {
    expect(blocksWith(orcQuotaOf(name, now)).filter((block) => block.title === "accounts")).toEqual([
      { provider: "claude", title: "accounts", body: { kind: "accounts-unread", cause, reason } },
    ]);
  });

  test("draws an orc that did not answer as a failed accounts block, keeping the live blocks", () => {
    const blocks = blocksWith({ kind: "unreachable", reason: "orc is not installed on PATH", capturedAt: now });
    expect(blocks.map((block) => block.title)).toEqual(["claude", "accounts", "codex", "opencode-go"]);
    expect(blocks[1]?.body).toEqual({ kind: "unreachable", reason: "orc is not installed on PATH" });
  });
});

describe("decodeOrcQuota", () => {
  test("refuses an unread cause orc quota does not print, rather than drawing it", () => {
    expect(decodeOrcQuota(JSON.stringify({ kind: "unread", cause: "offline", reason: "no network" })).kind).toBe("invalid");
  });

  test("refuses a read with no pick field, rather than reading every account as spare", () => {
    expect(decodeOrcQuota(JSON.stringify({ kind: "read", floorPercent: 20, accounts: [] })).kind).toBe("invalid");
  });
});
