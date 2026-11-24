import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import {
  decodeQuota,
  quotaBlocks,
  type QuotaReport,
  type Reading,
} from "@avi2dg/orc-schema";
import { fixture } from "../../lib/fixtures";
import { orcQuotaOf } from "../../lib/orc-quota";
import { quotaAxiRead } from "../../lib/quota-read";

// The frame time the pinned screen was recorded at, one second after the report.
const now = DateTime.makeUnsafe("2026-10-13T20:18:16Z");

const quotaReading = (text: string): Reading<QuotaReport> => {
  const decoded = decodeQuota(text);
  if (decoded.kind !== "ok") throw new Error("expected ok, got " + JSON.stringify(decoded));
  return { ...decoded, capturedAt: now };
};

const quota = (): string => fixture("quota-axi/full.json");
const accounts = () => orcQuotaOf("second-login-expired", now);

const without = (provider: string): string => {
  const parsed: unknown = JSON.parse(quota());
  if (typeof parsed !== "object" || parsed === null || !("providers" in parsed)) {
    throw new Error("the fixture holds no quota report");
  }
  if (!Array.isArray(parsed.providers)) throw new Error("the fixture holds no providers");
  return JSON.stringify({
    ...parsed,
    providers: parsed.providers.filter((entry) => !(typeof entry === "object" && entry !== null && "provider" in entry && entry.provider === provider)),
  });
};

// quota-axi --json keeps a provider nobody set up and marks it notSetUp, as the recorded cursor entry is.
const notSetUp = (provider: string): string => {
  const parsed: unknown = JSON.parse(quota());
  if (typeof parsed !== "object" || parsed === null || !("providers" in parsed) || !Array.isArray(parsed.providers)) {
    throw new Error("the fixture holds no providers");
  }
  const providers: ReadonlyArray<unknown> = parsed.providers;
  const isProvider = (name: string) => (entry: unknown) => typeof entry === "object" && entry !== null && "provider" in entry && entry.provider === name;
  const cursor = providers.find(isProvider("cursor"));
  if (typeof cursor !== "object" || cursor === null || !("notSetUp" in cursor)) throw new Error("the fixture has no cursor left unset");
  return JSON.stringify({
    ...parsed,
    providers: providers.map((entry) => (isProvider(provider)(entry) ? { ...cursor, provider } : entry)),
  });
};

describe("quotaBlocks, against the recorded quota-axi and orc quota reports", () => {
  test("names one block per account: live claude, orc quota's account, codex and opencode-go", () => {
    const blocks = quotaBlocks(quotaAxiRead(quotaReading(quota())), accounts(), now);
    expect(blocks.map((block) => block.title)).toEqual(["claude", "account second", "codex", "opencode-go"]);
    expect(blocks.map((block) => block.provider)).toEqual(["claude", "claude", "codex", "opencode-go"]);
  });

  test("the live claude block carries quota-axi's windows and plan, the account block orc quota's reason, not the saved profile's 7d window", () => {
    const blocks = quotaBlocks(quotaAxiRead(quotaReading(quota())), accounts(), now);
    const [live, account] = blocks;
    if (live.body.kind !== "live") throw new Error("expected a live claude block");
    expect(live.body.plan).toBe("max");
    expect(live.body.windows.length).toBeGreaterThan(0);
    expect(account.body).toEqual({ kind: "unusable", reason: "its login expired" });
  });

  test("a provider quota-axi left out of its report reads absent, not live", () => {
    const blocks = quotaBlocks(quotaAxiRead(quotaReading(without("codex"))), accounts(), now);
    expect(blocks.find((block) => block.title === "codex")?.body).toEqual({ kind: "absent" });
  });

  test("a provider quota-axi reports not set up gets no block", () => {
    const blocks = quotaBlocks(quotaAxiRead(quotaReading(notSetUp("codex"))), accounts(), now);
    expect(blocks.map((block) => block.title)).toEqual(["claude", "account second", "opencode-go"]);
  });

  test("an unreachable quota-axi reaches every live block with its reason", () => {
    const failed: Reading<QuotaReport> = { kind: "unreachable", reason: "quota-axi did not start", capturedAt: now };
    const blocks = quotaBlocks(quotaAxiRead(failed), accounts(), now);
    expect(blocks.filter((block) => block.title !== "account second").map((block) => block.body)).toEqual([
      { kind: "unreachable", reason: "quota-axi did not start" },
      { kind: "unreachable", reason: "quota-axi did not start" },
      { kind: "unreachable", reason: "quota-axi did not start" },
    ]);
  });

  test("a schema-6 report names one live block per account, leaving the default filler out", () => {
    const decoded = decodeQuota(fixture("quota-axi/schema-6.json"));
    if (decoded.kind !== "ok") throw new Error("expected ok, got " + JSON.stringify(decoded));
    const blocks = quotaBlocks(quotaAxiRead({ ...decoded, capturedAt: now }), accounts(), now);
    expect(blocks.map((block) => block.title)).toEqual([
      "claude",
      "account second",
      "codex codex-home",
      "codex openai-codex",
      "opencode-go",
    ]);
    expect(blocks.map((block) => block.provider)).toEqual(["claude", "claude", "codex", "codex", "opencode-go"]);
  });

  test("each account block carries its own row's windows", () => {
    const decoded = decodeQuota(fixture("quota-axi/schema-6.json"));
    if (decoded.kind !== "ok") throw new Error("expected ok, got " + JSON.stringify(decoded));
    const blocks = quotaBlocks(quotaAxiRead({ ...decoded, capturedAt: now }), accounts(), now);
    const fiveHour = (title: string): number => {
      const block = blocks.find((candidate) => candidate.title === title);
      if (block?.body.kind !== "live") throw new Error("expected a live block for " + title);
      const window = block.body.windows.find((candidate) => candidate.id === "five_hour");
      if (window === undefined || !("percentRemaining" in window)) throw new Error("no five-hour window for " + title);
      return window.percentRemaining;
    };
    expect(fiveHour("codex codex-home")).toBe(100);
    expect(fiveHour("codex openai-codex")).toBe(29);
  });

  test("a failed account row keeps its account in the title, and its sibling stays live", () => {
    const parsed: unknown = JSON.parse(fixture("quota-axi/schema-6.json"));
    if (typeof parsed !== "object" || parsed === null || !("providers" in parsed)) {
      throw new Error("the fixture holds no quota report");
    }
    if (!Array.isArray(parsed.providers)) throw new Error("the fixture holds no providers");
    const second = parsed.providers.find(
      (entry): entry is { accountKey: unknown; windows: Array<Record<string, unknown>> } =>
        typeof entry === "object" &&
        entry !== null &&
        "accountKey" in entry &&
        entry.accountKey === "openai-codex" &&
        "windows" in entry &&
        Array.isArray(entry.windows),
    );
    if (second?.windows[0] === undefined) throw new Error("the fixture has no second codex window to break");
    delete second.windows[0]["percentRemaining"];
    const decoded = decodeQuota(JSON.stringify(parsed));
    if (decoded.kind !== "ok") throw new Error("expected ok, got " + JSON.stringify(decoded));
    const blocks = quotaBlocks(quotaAxiRead({ ...decoded, capturedAt: now }), accounts(), now);
    const broken = blocks.find((block) => block.title === "codex openai-codex");
    const sibling = blocks.find((block) => block.title === "codex codex-home");
    if (broken?.body.kind !== "invalid") throw new Error("expected an invalid openai-codex block");
    expect(broken.body.issue).toContain("codex");
    if (sibling?.body.kind !== "live") throw new Error("expected a live codex-home block");
  });

});
