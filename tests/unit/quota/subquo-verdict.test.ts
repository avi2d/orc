import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { decodeQuota, overlaySubquo, quotaBlocks } from "@avi2dg/orc-schema";
import { plain, quotaLines } from "@avi2dg/orc-quota";
import { fixture } from "../../lib/fixtures";
import { orcQuotaOf } from "../../lib/orc-quota";
import { quotaAxiRead } from "../../lib/quota-read";

const now = DateTime.makeUnsafe("2026-10-13T20:20:00.000Z");
const quota = decodeQuota(fixture("quota-axi/full.json"));
if (quota.kind !== "ok") throw new Error(quota.issue);

const snapshot = (id: string, provider: string, window: string) => ({
  version: "subquo.v1",
  writtenAt: "2026-10-13T20:19:30.000Z",
  accounts: [{
    id,
    provider,
    observation: {
      status: "fresh",
      source: "provider",
      observedAt: "2026-10-13T20:19:30.000Z",
      validUntil: "2026-10-13T20:21:30.000Z",
      windows: [{ id: window, scope: "all", percentLeft: 40, resetsAt: "2026-10-16T17:00:00.000Z" }],
    },
  }],
});

const rowsOf = (subquo: unknown, provider: "claude" | "opencode-go", subquoId: string): ReadonlyArray<string> => {
  const report = overlaySubquo(quota.value, subquo, [{ provider, accountKey: "default", subquoId }], now);
  const blocks = quotaBlocks(quotaAxiRead({ kind: "ok", capturedAt: now, value: report }), orcQuotaOf("second-login-expired", now), now)
    .filter((block) => block.provider === provider);
  return quotaLines(blocks, 100, true, now).map(plain);
};

describe("quota rows beside a subquo reading", () => {
  test("keeps quota-axi's runway on the monthly row instead of dropping it when subquo replaces the rolling window", () => {
    const rows = rowsOf(snapshot("go", "opencode-go", "five-hour"), "opencode-go", "go");
    expect(rows.find((row) => row.startsWith("rolling"))).toContain("40%");
    expect(rows.find((row) => row.startsWith("month"))).toContain("empty in");
  });

  test("leaves the subquo week row without quota-axi's runway instead of projecting it from quota-axi's reading", () => {
    const rows = rowsOf(snapshot("main", "claude", "weekly"), "claude", "main");
    const week = rows.find((row) => row.startsWith("week"));
    expect(week).toContain("40%");
    expect(week).not.toContain("empty in");
  });
});
