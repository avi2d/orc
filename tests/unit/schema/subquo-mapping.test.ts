import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { decodeQuota, overlaySubquo } from "@avi2dg/orc-schema";
import { fixture } from "../../lib/fixtures";

const quota = decodeQuota(fixture("quota-axi/full.json"));
if (quota.kind !== "ok") throw new Error(quota.issue);
const report = quota.value;
const snapshot: unknown = JSON.parse(fixture("subquo/schema-built-read.json"));
const now = DateTime.makeUnsafe("2026-11-22T20:01:00.000Z");
const mapping = { provider: "claude", accountKey: "default", subquoId: "main" } as const;

describe("subquo quota account mappings", () => {
  test("reads the mapped account instead of retaining the quota-axi window", () => {
    const result = overlaySubquo(report, snapshot, [mapping], now);
    const entry = result.providers.find((item) => item.provider === "claude" && !("kind" in item));
    if (entry === undefined || "kind" in entry) throw new Error("Claude account missing");
    const window = entry.windows.find((item) => item.id === "five_hour");
    expect(window && "percentRemaining" in window ? window.percentRemaining : undefined).toBe(62);
    expect(window?.subquoReadAt).toEqual(DateTime.makeUnsafe("2026-11-22T20:00:00.000Z"));
  });

  test("keeps the original account instead of using a different snapshot account when the ID is missing", () => {
    const result = overlaySubquo(report, snapshot, [{ ...mapping, subquoId: "missing" }], now);
    expect(result.providers).toEqual(report.providers);
  });

  test("keeps the original account instead of using a snapshot ID from a different provider", () => {
    const result = overlaySubquo(report, snapshot, [{ ...mapping, subquoId: "codex-home" }], now);
    expect(result.providers).toEqual(report.providers);
  });

  test("shows the mapped account instead of dropping it when quota-axi has no account", () => {
    const empty = { generatedAt: now, providers: [], notSetUp: ["claude"] as const };
    const result = overlaySubquo(empty, snapshot, [mapping], now);
    expect(result.providers).toHaveLength(1);
    expect(result.notSetUp).toEqual([]);
  });

  const opencodeWindow = (readId: string, windowId: string) => {
    const subquo = {
      version: "subquo.v1",
      writtenAt: "2026-11-22T20:00:00.000Z",
      accounts: [{
        id: "go",
        provider: "opencode-go",
        observation: {
          status: "fresh",
          source: "provider",
          observedAt: "2026-11-22T20:00:00.000Z",
          validUntil: "2026-11-22T20:02:00.000Z",
          windows: [{ id: readId, scope: "all", percentLeft: 37, resetsAt: "2026-12-22T20:00:00.000Z" }],
        },
      }],
    };
    const result = overlaySubquo(report, subquo, [{ provider: "opencode-go", accountKey: "default", subquoId: "go" }], now);
    const entry = result.providers.find((item) => item.provider === "opencode-go" && !("kind" in item));
    if (entry === undefined || "kind" in entry) throw new Error("OpenCode account missing");
    const window = entry.windows.find((item) => item.id === windowId);
    return window && "percentRemaining" in window ? window.percentRemaining : undefined;
  };

  test("uses the mapped OpenCode monthly window instead of quota-axi's value", () => {
    expect(opencodeWindow("monthly", "monthly")).toBe(37);
  });

  test("uses an OpenCode five-hour reading for a five-hour rolling window instead of retaining quota-axi", () => {
    expect(opencodeWindow("five-hour", "rolling")).toBe(37);
  });

  const claudeWindows = (windows: ReadonlyArray<unknown>) => {
    const subquo = {
      version: "subquo.v1",
      writtenAt: "2026-11-22T20:00:30.000Z",
      accounts: [{
        id: "main", provider: "claude",
        observation: {
          status: "fresh", source: "provider", observedAt: "2026-11-22T20:00:00.000Z",
          validUntil: "2026-11-22T20:02:00.000Z",
          windows,
        },
      }],
    };
    const result = overlaySubquo(report, subquo, [mapping], now);
    const entry = result.providers.find((item) => item.provider === "claude" && !("kind" in item));
    if (entry === undefined || "kind" in entry) throw new Error("Claude account missing");
    return entry.windows;
  };

  test("keeps the quota-axi window as for an absent window instead of dropping it when subquo did not return it", () => {
    const weekly = { id: "weekly", scope: "all", percentLeft: 35, resetsAt: "2026-11-28T12:00:00.000Z" };
    const notReturned = claudeWindows([weekly, { id: "five-hour", percentLeft: null, resetsAt: null, status: "not_returned" }]);
    const original = report.providers.find((item) => item.provider === "claude" && !("kind" in item));
    if (original === undefined || "kind" in original) throw new Error("Claude account missing");
    expect(notReturned).toEqual(claudeWindows([weekly]));
    expect(notReturned.find((window) => window.id === "five_hour")).toEqual(original.windows.find((window) => window.id === "five_hour"));
  });

  test("keeps quota-axi instead of using an expired subquo reading", () => {
    const result = overlaySubquo(report, snapshot, [mapping], DateTime.makeUnsafe("2026-11-22T20:03:00.000Z"));
    expect(result.providers).toEqual(report.providers);
  });
});
