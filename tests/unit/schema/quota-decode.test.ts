import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { decodeSavedProfiles, decodeQuota } from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";

const full = (): string => fixture("quota-axi/full.json");

const reportOf = (text: string) => {
  const decoded = decodeQuota(text);
  if (decoded.kind !== "ok") throw new Error("expected ok, got " + JSON.stringify(decoded));
  return decoded.value;
};

describe("decodeQuota, against quota-axi --full --json at schemaVersion 5", () => {
  test("keeps the recorded time and the three shown providers in report order", () => {
    const report = reportOf(full());
    expect(DateTime.toEpochMillis(report.generatedAt)).toBe(Date.parse("2026-10-13T20:18:15.620Z"));
    expect(report.providers.map((entry) => entry.provider)).toEqual(["claude", "codex", "opencode-go"]);
  });

  test("drops every provider the panel never shows", () => {
    const parsed: unknown = JSON.parse(full());
    if (typeof parsed !== "object" || parsed === null || !("providers" in parsed)) {
      throw new Error("the fixture holds no quota report");
    }
    expect(parsed.providers).toHaveLength(18);
    expect(reportOf(full()).providers).toHaveLength(3);
  });

  test("a window quota-axi changed shape on fails that provider, not the report", () => {
    const parsed: unknown = JSON.parse(full());
    if (typeof parsed !== "object" || parsed === null || !("providers" in parsed)) {
      throw new Error("the fixture holds no quota report");
    }
    if (!Array.isArray(parsed.providers)) throw new Error("the fixture holds no providers");
    const codex = parsed.providers.find(
      (entry): entry is { provider: unknown; windows: Array<Record<string, unknown>> } =>
        typeof entry === "object" &&
        entry !== null &&
        "provider" in entry &&
        "windows" in entry &&
        Array.isArray(entry.windows) &&
        entry.provider === "codex",
    );
    if (codex?.windows[0] === undefined) throw new Error("the fixture has no codex window to break");
    delete codex.windows[0]["percentRemaining"];
    const report = reportOf(JSON.stringify(parsed));
    const entry = report.providers.find((candidate) => candidate.provider === "codex");
    if (entry === undefined || !("kind" in entry) || entry.kind !== "invalid") {
      throw new Error("expected an invalid codex entry");
    }
    expect(entry.issue).toContain("codex");
  });

  test("refuses text that is not JSON", () => {
    expect(decodeQuota("not json")).toEqual({ kind: "invalid", issue: "the output is not JSON" });
  });

  test("refuses another schemaVersion", () => {
    const parsed: unknown = JSON.parse(full());
    if (typeof parsed !== "object" || parsed === null) throw new Error("the fixture holds no quota report");
    const decoded = decodeQuota(JSON.stringify({ ...parsed, schemaVersion: 4 }));
    if (decoded.kind !== "invalid") throw new Error("expected an invalid report");
    expect(decoded.issue).toContain("schemaVersion");
  });
});

describe("decodeQuota, against a recorded two-Codex-account replay at schemaVersion 6", () => {
  const six = (): string => fixture("quota-axi/schema-6.json");

  test("decodes the expansion, keeping report order and every account row", () => {
    const report = reportOf(six());
    expect(report.providers.map((entry) => entry.provider)).toEqual([
      "claude",
      "codex",
      "codex",
      "opencode-go",
    ]);
  });

  test("reads each row's accountKey, default filler and all", () => {
    const report = reportOf(six());
    expect(report.providers.map((entry) => ("kind" in entry ? null : entry.accountKey))).toEqual([
      "default",
      "codex-home",
      "openai-codex",
      "default",
    ]);
  });

  test("a broken window fails its own account row, keeping the sibling", () => {
    const parsed: unknown = JSON.parse(six());
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
    const report = reportOf(JSON.stringify(parsed));
    const rows = report.providers.filter((entry) => entry.provider === "codex");
    expect(rows.map((entry) => ("kind" in entry ? entry.kind : "ok"))).toEqual(["ok", "invalid"]);
  });
});

describe("decodeSavedProfiles, against a recorded saved profiles report at schema 2", () => {
  test("reads the active profile and the saved profiles", () => {
    const decoded = decodeSavedProfiles(fixture("saved-profiles/status.json"));
    if (decoded.kind !== "ok") throw new Error("expected ok, got " + JSON.stringify(decoded));
    expect(decoded.value.active_profile).toBe("main");
    expect(decoded.value.profiles.map((profile) => profile.name)).toEqual(["main", "second"]);
  });

  test("refuses text that is not JSON", () => {
    expect(decodeSavedProfiles("{oops")).toEqual({ kind: "invalid", issue: "the output is not JSON" });
  });
});
