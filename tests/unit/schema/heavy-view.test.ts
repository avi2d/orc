import { describe, expect, test } from "bun:test";
import { heavySummary, isHeavyNotSetup } from "@avi2dg/orc-schema";

describe("the heavy summary line", () => {
  test("a call queued under a minute ago reads 0m", () => {
    expect(heavySummary({ group: "heavy", parallel: 1, running: [], queued: [{ id: 4, command: "bun test", ageMinutes: 0 }], bypass: 0, bypassWeek: 0 })).toBe(
      "0/1 running \u00b7 1 queued, oldest 0m \u00b7 0 bypasses this week",
    );
  });

  test("names one bypass in the singular rather than as 1 bypasses", () => {
    expect(heavySummary({ group: "heavy", parallel: 1, running: [], queued: [], bypass: 4, bypassWeek: 1 })).toBe("0/1 running \u00b7 0 queued \u00b7 1 bypass this week");
  });
});

describe("the heavy queue not set up note", () => {
  test("a zsh shell that cannot find orc reads as not set up, not as a failure", () => {
    expect(isHeavyNotSetup({ kind: "unreachable", reason: "sh exited 127: zsh:1: command not found: orc" })).toBe(true);
  });

  test("a zsh shell that cannot find another command starting with orc is still a failure", () => {
    expect(isHeavyNotSetup({ kind: "unreachable", reason: "sh exited 127: zsh:1: command not found: orc-dash" })).toBe(false);
  });
});
