import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import type { HarvestOrigin } from "@tui-dash/schema";
import { joinWords, sourceWords } from "@tui-dash/ui";

const now = DateTime.makeUnsafe("2026-10-13T20:18:16Z");

const secondsBefore = (seconds: number): DateTime.Utc => DateTime.makeUnsafe(DateTime.toEpochMillis(now) - seconds * 1000);

describe("where a window came from", () => {
  test("says quota-axi read it just now under a minute, else how long ago", () => {
    expect(sourceWords({ kind: "quota-axi", readAt: secondsBefore(30) }, now)).toBe("quota-axi just now");
    expect(sourceWords({ kind: "quota-axi", readAt: secondsBefore(60) }, now)).toBe("quota-axi 1m ago");
    expect(sourceWords({ kind: "quota-axi", readAt: secondsBefore(4680) }, now)).toBe("quota-axi 1h 18m ago");
  });

  test("names the harness log or statusline a harvested window came from", () => {
    const harvested = (origin: HarvestOrigin) =>
      sourceWords(
        { kind: "harvested", ...origin, observedAt: secondsBefore(2280), file: "/f", join: { kind: "only-account" } },
        now,
      );
    expect(harvested({ harness: "codex", via: "log" })).toBe("codex rollout 38m ago");
    expect(harvested({ harness: "claude-code", via: "log" })).toBe("claude code log 38m ago");
    expect(harvested({ harness: "claude-code", via: "statusline" })).toBe("claude code statusline 38m ago");
    expect(harvested({ harness: "claude-code", via: "headless" })).toBe("claude code headless 38m ago");
  });
});

describe("how a window joined its account", () => {
  test("names the key only when every join had one", () => {
    expect(joinWords([])).toBeUndefined();
    expect(joinWords([{ kind: "credential-key", key: "codex-home" }])).toBe("joined by credential key");
    expect(joinWords([{ kind: "credential-key", key: "codex-home" }, { kind: "only-account" }])).toBe("assumed the only login");
    expect(joinWords([{ kind: "only-account" }, { kind: "default-account" }])).toBe("assumed the default login");
  });
});
