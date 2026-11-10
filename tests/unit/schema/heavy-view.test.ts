import { describe, expect, test } from "bun:test";
import { heavySummary } from "@avi2dg/orc-schema";

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
