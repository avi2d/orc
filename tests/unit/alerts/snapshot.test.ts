import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { type AlertReadings, alertsSection, alertsSummary } from "@tui-dash/alerts";
import { decodeAlertSettings, type VerdictEntry } from "@tui-dash/schema";
import { lineWidth, plain } from "@tui-dash/ui";
import { recordedAlerts, recordedEntries, verdictLogPath } from "../../lib/alerts-fixture";
import { fixture } from "../../lib/fixtures";

const now = DateTime.makeUnsafe("2026-10-19T19:20:00Z");

const readings = (change: Partial<AlertReadings> = {}): AlertReadings => ({ ...recordedAlerts(), ...change });

const logOf = (entries: ReadonlyArray<VerdictEntry>, unreadable = 0, lastIssue?: string): AlertReadings["verdicts"] => ({
  kind: "ok",
  value: { path: verdictLogPath, log: { entries, unreadable, lastIssue } },
});

const printed = (from = readings(), width = 84): ReadonlyArray<string> => alertsSection(from, now, width).map(plain);

const ruleOf = (lines: ReadonlyArray<string>, rule: string): ReadonlyArray<string> => {
  const start = lines.indexOf(`alert    ${rule}`);
  if (start === -1) throw new Error(`no ${rule} rule`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("alert "));
  return lines.slice(start + 1, end === -1 ? undefined : end);
};

const labelled = (lines: ReadonlyArray<string>, label: string): ReadonlyArray<string> => {
  const start = lines.findIndex((line) => line.startsWith(`${label} `));
  if (start === -1) throw new Error(`no ${label} row`);
  const end = lines.findIndex((line, index) => index > start && !line.startsWith("         "));
  return lines.slice(start, end === -1 ? undefined : end);
};

// Oracle: panels.alerts in tests/fixtures/config/config.json, read by hand: north at load 10 or 90% used, south at load 16 or under 15% free,
// and long tasks quiet for 20 minutes, again every 10, and past 3 hours, beside the README defaults it leaves alone.
// Rejects a panel that shows the default limits whatever the settings file says.
describe("the alerts panel shows each rule's limits from the settings file", () => {
  test("for every rule, in the order the engine runs them", () => {
    const lines = printed();
    expect(lines.filter((line) => line.startsWith("alert ")).map((line) => line.split(/ +/u)[1])).toEqual(["quota-pace", "heavy-load", "long-task", "nightly"]);
    expect(ruleOf(lines, "quota-pace").slice(0, 3)).toEqual([
      "limits   a window runs ahead of pace past its first tenth and runs out before its",
      "         reset",
      "         read every 1m",
    ]);
    expect(ruleOf(lines, "heavy-load").slice(0, 2)).toEqual([
      "limits   north load ≥ 10 or memory used ≥ 90% · south load ≥ 16 or memory free < 15%",
      "         over for 5m · read every 30s",
    ]);
    expect(ruleOf(lines, "long-task").slice(0, 2)).toEqual([
      "limits   quiet 20m, then every 10m · past 3h in total",
      "         watches working, waiting and blocked · read every 30s",
    ]);
    expect(ruleOf(lines, "nightly").slice(0, 2)).toEqual([
      "limits   no repository mapped to an owner home · read every 5m",
      "fired    none recorded",
    ]);
  });

  // Oracle: half a minute is 30 seconds and a quarter hour is 15 minutes, by hand, and 0.001 percent is above zero.
  // Rejects a lowered limit rounded to 0, which would read as a rule that always fires.
  test("keeping a small or fractional limit as it is set", () => {
    const settings = decodeAlertSettings({
      heavyLoad: { sustainedMinutes: 0.5, machines: [{ name: "north", loadAtLeast: 1000, memory: { usedAtLeastPercent: 0.001 } }] },
      longTask: { totalHours: 0.25, everySeconds: 0.2 },
    });
    if (settings.kind !== "ok") throw new Error("the settings do not decode");
    const lines = printed(readings({ settings: settings.value }));
    expect(ruleOf(lines, "heavy-load")[0]).toBe("limits   north load ≥ 1000 or memory used ≥ 0.001% · over for 30s · read every 30s");
    expect(ruleOf(lines, "long-task")[0]).toBe("limits   quiet 15m, then every 15m · past 15m in total");
    expect(ruleOf(lines, "long-task")[1]).toBe("         watches working, waiting and blocked · read every 0.2s");
  });
});

// Oracle: the verdict record contract applied by hand to the six recorded lines at 19:20: heavy load fired at 18:40 on south and north,
// judged by its south line; long task fired last at 19:10, quiet 30m, while its only verdict judged the 18:55 fire; quota pace has no line.
// Rejects a fire shown twice for its two lines, a verdict pinned on a fire it did not judge, and a rule with no line shown as judged.
describe("the alerts panel shows each rule's last fire and the listener's verdict", () => {
  const lines = printed();

  test("for a rule that never fired", () => {
    expect(ruleOf(lines, "quota-pace").slice(3)).toEqual(["fired    none recorded"]);
  });

  test("for a fire the listener judged", () => {
    expect(ruleOf(lines, "heavy-load").slice(2)).toEqual([
      "fired    40m ago · south over memory · north over load",
      "verdict  expected, a nightly baseline runs on south",
    ]);
  });

  test("for a fire the listener has not judged yet, beside the earlier fire it did", () => {
    expect(ruleOf(lines, "long-task").slice(2)).toEqual([
      "fired    10m ago · Plot the bridge migration on north, quiet 30m",
      "verdict  none on this fire",
      "earlier  25m ago · Plot the bridge migration on north, quiet 15m",
      "         still moving the queue, let it run",
    ]);
  });

  test("for a fire with no verdict recorded at all", () => {
    const unjudged = recordedEntries().filter((entry) => entry.verdict === null);
    expect(ruleOf(printed(readings({ verdicts: logOf(unjudged) })), "heavy-load").at(-1)).toBe("verdict  none recorded");
  });
});

// Oracle: the brief's rule that a source reports failed without blocking the rest, and a contract line that is not a record still counts.
// Rejects a panel that hides a log it could not read behind rules that look calm, or drops broken lines without a word.
describe("the alerts panel with a verdict log it cannot use", () => {
  test("gives the reason and leaves every fire unknown", () => {
    const shown = printed(readings({ verdicts: { kind: "unreachable", reason: `${verdictLogPath} cannot be read` } }));
    expect(labelled(shown, "verdicts").map((line) => line.slice(9)).join(" ")).toBe(`✗ unreachable: ${verdictLogPath} cannot be read`);
    for (const rule of ["quota-pace", "heavy-load", "long-task", "nightly"]) expect(ruleOf(shown, rule).at(-1)).toBe("fired    unknown until the verdict log reads");
  });

  test("says so in the summary's header, with every rule's last fire unknown", () => {
    const shown = alertsSummary(readings({ verdicts: { kind: "unreachable", reason: "lost" } }), now, 84).map(plain);
    expect(shown).toEqual(["alerts · ✗ verdict log unread", "quota-pace unknown", "heavy-load unknown", "long-task  unknown", "nightly    unknown"]);
  });

  test("counts the unreadable lines, with the last one's issue", () => {
    const shown = printed(readings({ verdicts: logOf(recordedEntries(), 2, "the output is not JSON") }));
    expect(labelled(shown, "verdicts").map((line) => line.slice(9)).join(" ")).toBe(
      `! 2 lines in ${verdictLogPath} are not verdict records, the last: the output is not JSON`,
    );
  });

  // Oracle: the agreed wording for the header, "1 unreadable verdict line", with the count pluralised as lines.
  // Rejects a summary header that reads "1 unreadable verdict lines" or "2 unreadable verdict line".
  for (const [unreadable, words] of [[1, "1 unreadable verdict line"], [2, "2 unreadable verdict lines"]] as const) {
    test(`says ${words} in the summary's header`, () => {
      const shown = alertsSummary(readings({ verdicts: logOf(recordedEntries(), unreadable, "the output is not JSON") }), now, 84).map(plain);
      expect(shown[0]).toBe(`alerts · ! ${words}`);
    });
  }
});

const adversarial = (verdict: string): ReadonlyArray<VerdictEntry> =>
  recordedEntries().map((entry) => (entry.verdict === null ? entry : { ...entry, verdict }));

// Oracle: the nine column label, and a terminal escape that must reach the screen as text, not as a command.
// Rejects a line wider than the terminal, a long verdict that pushes the rules off screen, and an escape the listener wrote painting the terminal.
describe("the alerts panel fits the terminal it runs in", () => {
  for (const width of [30, 40, 84]) {
    test(`keeps every line inside ${width} columns with a long verdict`, () => {
      const shown = alertsSection(readings({ verdicts: logOf(adversarial("word ".repeat(200))) }), now, width);
      for (const line of shown) expect(lineWidth(line)).toBeLessThanOrEqual(width);
      expect(labelled(ruleOf(shown.map(plain), "heavy-load"), "verdict")).toHaveLength(3);
    });
  }

  test("shows a verdict's escape codes as plain text", () => {
    const shown = printed(readings({ verdicts: logOf(adversarial("fine\u001b[2J\u001b[31m now")) }));
    expect(shown.join("\n")).not.toContain("\u001b");
    expect(ruleOf(shown, "heavy-load").at(-1)).toBe("verdict  fine[2J[31m now");
  });

  // Oracle: Unicode's East Asian Width property makes 界 two columns wide, so the 75 columns past the label hold 37 of them, by hand.
  // Rejects a split by UTF-16 length, which keeps all 50 on one 100 column row and cuts the rest to an ellipsis.
  test("breaks a word of wide characters by the columns they take", () => {
    const verdict = labelled(ruleOf(printed(readings({ verdicts: logOf(adversarial("界".repeat(50))) })), "heavy-load"), "verdict");
    expect(verdict).toEqual([`verdict  ${"界".repeat(37)}`, `         ${"界".repeat(13)}`]);
  });

  // Oracle: an emoji is one grapheme two columns wide, so the 21 columns past the label at width 30 hold 10 of them, by hand.
  // Rejects a break inside a surrogate pair, which leaves a half emoji on each side of the break.
  test("breaks a word of emoji between graphemes in a read error", () => {
    const shown = printed(readings({ verdicts: { kind: "unreachable", reason: "👍".repeat(30) } }), 30);
    expect(labelled(shown, "verdicts")).toEqual(["verdicts ✗ unreachable:", ...Array.from({ length: 3 }, () => `         ${"👍".repeat(10)}`)]);
  });
});

// Oracle: the screen recorded from the same fixtures at 19:20, read by eye against the hand-computed ages above. Rejects any drift from it.
describe("the alerts panel, against its pinned recording", () => {
  test("renders the pinned frame at 84 columns", () => {
    expect(`${printed().join("\n")}\n`).toBe(fixture("screens/alerts-84x18.txt"));
  });
});
