import type { AlertReadings } from "@tui-dash/alerts";
import { type AlertSettings, decodeAlertSettings, decodeConfigText, decodeVerdictLine, type VerdictEntry } from "@tui-dash/schema";
import { fixture } from "./fixtures";

export const verdictLogPath = "/home/tester/.local/state/tui-dash/alerts-verdicts.jsonl";

export const recordedEntries = (text = fixture("alerts/verdicts.jsonl")): ReadonlyArray<VerdictEntry> =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const entry = decodeVerdictLine(line);
      if (entry.kind !== "ok") throw new Error(`the fixture line does not decode: ${entry.issue}`);
      return entry.value;
    });

export const recordedSettings = (): AlertSettings => {
  const config = decodeConfigText(fixture("config/config.json"));
  if (config.kind !== "ok") throw new Error("the config fixture does not decode");
  const settings = decodeAlertSettings(config.value.panels["alerts"]);
  if (settings.kind !== "ok") throw new Error("the settings fixture does not decode");
  return settings.value;
};

export const recordedAlerts = (entries = recordedEntries()): AlertReadings => ({
  settings: recordedSettings(),
  verdicts: { kind: "ok", value: { path: verdictLogPath, log: { entries, unreadable: 0, lastIssue: undefined } } },
});
