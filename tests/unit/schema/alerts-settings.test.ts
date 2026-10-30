import { describe, expect, test } from "bun:test";
import { decodeAlertSettings, defaultAlertSettings } from "@tui-dash/schema";
import { issueOf, valueOf } from "../../lib/outcomes";

describe("the alert settings", () => {
  test("default to the limits and timings of the brief", () => {
    expect(valueOf(decodeAlertSettings({}))).toEqual(defaultAlertSettings);
    expect(defaultAlertSettings.heavyLoad).toMatchObject({
      sustainedMinutes: 5,
      machines: [
        { name: "local", loadAtLeast: 10, memory: { usedAtLeastPercent: 90 } },
        { name: "remote", loadAtLeast: 16, memory: { availableUnderPercent: 15 } },
      ],
    });
    expect(defaultAlertSettings.longTask).toMatchObject({ quietMinutes: 15, repeatMinutes: 15, totalHours: 2 });
    expect(defaultAlertSettings.nightly).toEqual({ everySeconds: 300, homes: {} });
  });

  test("keep every default a file leaves out", () => {
    const settings = valueOf(decodeAlertSettings({ heavyLoad: { sustainedMinutes: 1, machines: [{ name: "north", loadAtLeast: 2, memory: { usedAtLeastPercent: 50 } }] } }));
    expect(settings.heavyLoad).toEqual({
      ...defaultAlertSettings.heavyLoad,
      sustainedMinutes: 1,
      machines: [{ name: "north", loadAtLeast: 2, memory: { usedAtLeastPercent: 50 } }],
    });
    expect(settings.longTask).toEqual(defaultAlertSettings.longTask);
    expect(settings.quotaPace).toEqual(defaultAlertSettings.quotaPace);
    expect(settings.nightly).toEqual(defaultAlertSettings.nightly);
  });

  test("refuse a misspelt key, a percent past 100, a home that is no string, a memory limit naming both kinds, and a state no task takes", () => {
    expect(issueOf(decodeAlertSettings({ heavyLoad: { sustainedMinute: 1 } }))).toContain('["heavyLoad"]["sustainedMinute"]');
    expect(issueOf(decodeAlertSettings({ heavyLoad: { machines: [{ name: "north", loadAtLeast: 2, memory: { usedAtLeastPercent: 120 } }] } }))).toContain(
      "less than or equal to 100",
    );
    expect(
      issueOf(
        decodeAlertSettings({ heavyLoad: { machines: [{ name: "north", loadAtLeast: 2, memory: { usedAtLeastPercent: 50, availableUnderPercent: 10 } }] } }),
      ),
    ).toContain("excess property");
    expect(issueOf(decodeAlertSettings({ longTask: { states: ["working", "sleeping"] } }))).toContain('["longTask"]["states"][1]');
    expect(issueOf(decodeAlertSettings({ nightly: { homes: { "example/website": 3 } } }))).toContain('["nightly"]["homes"]');
  });
});
