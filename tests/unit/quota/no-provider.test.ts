import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { decodeQuota, decodeSavedProfiles, quotaBlocks } from "@avi2dg/orc-schema";
import { plain, quotaLines, quotaPlaced, quotaSection, reserveQuotaSection } from "@avi2dg/orc-quota";
import { fixture } from "../../lib/fixtures";
import { quotaAxiRead } from "../../lib/quota-read";

const now = DateTime.makeUnsafe("2026-10-13T20:18:16Z");

const providerOf = (entry: unknown): unknown => (typeof entry === "object" && entry !== null && "provider" in entry ? entry.provider : undefined);

// cursor's entry in the recorded report is quota-axi's own not-set-up shape, so every provider takes it on.
const noneSetUp = (): string => {
  const parsed: unknown = JSON.parse(fixture("quota-axi/full.json"));
  if (typeof parsed !== "object" || parsed === null || !("providers" in parsed) || !Array.isArray(parsed.providers)) {
    throw new Error("the fixture holds no quota report");
  }
  const providers: ReadonlyArray<unknown> = parsed.providers;
  const cursor = providers.find((entry) => providerOf(entry) === "cursor");
  if (typeof cursor !== "object" || cursor === null) throw new Error("the fixture holds no cursor entry");
  return JSON.stringify({ ...parsed, providers: providers.map((entry) => ({ ...cursor, provider: providerOf(entry) })) });
};

const blocks = () => {
  const quota = decodeQuota(noneSetUp());
  const savedProfiles = decodeSavedProfiles(JSON.stringify({ schema: 2, active_profile: null, profiles: [] }));
  if (quota.kind !== "ok" || savedProfiles.kind !== "ok") throw new Error("the fixtures do not decode");
  return quotaBlocks(quotaAxiRead({ ...quota, capturedAt: now }), { ...savedProfiles, capturedAt: now }, now);
};

const look = { focused: false, title: undefined, below: [], alone: false };

const boxText = (shown: Parameters<typeof quotaPlaced>[0]): string =>
  quotaPlaced(shown).box({ columns: 60, rows: 10 }, look).block.map(plain).join("\n");

const said = "no provider is set up in quota-axi";

describe("a quota report with no provider set up", () => {
  test("the report holds no provider block", () => {
    expect(blocks()).toEqual([]);
  });

  test("says so in the box, the glance and the printed panel", () => {
    const live = boxText(() => ({ shown: { kind: "live", value: blocks(), at: 0 }, now, refreshing: false }));
    expect(live).toContain(said);
    expect(live).not.toContain("reading the quota");
    const glance = quotaPlaced(() => ({ shown: { kind: "live", value: blocks(), at: 0 }, now, refreshing: false })).glance(60).map((block) => block.map(plain).join("\n"));
    expect(glance.every((text) => text.includes(said))).toBe(true);
    expect(quotaLines(blocks(), 60, true, now).map(plain).join("\n")).toContain(said);
    expect(quotaSection(blocks(), 60, now, 0).map(plain).join("\n")).toContain(said);
    expect(reserveQuotaSection(blocks(), 60, now, 0).map(plain).join("\n")).toContain(said);
  });

  test("a box with no reading yet still says it is reading", () => {
    const pending = boxText(() => ({ shown: { kind: "pending" }, now, refreshing: false }));
    expect(pending).toContain("reading the quota");
    expect(pending).not.toContain(said);
  });
});
