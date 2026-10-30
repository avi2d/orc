import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DateTime } from "effect";
import {
  decodeSavedProfiles,
  decodeHerdrPanes,
  decodeLinuxHarnessProcesses,
  type Harness,
  homeLogRoots,
  type LogFile,
  logRecords,
  nothingCaptured,
  type SessionQuotaView,
  sessionQuotaFrom,
} from "@tui-dash/schema";
import { fixture } from "./fixtures";
import { claudeLogFile, readBeforeHarvest, rolloutFile } from "./harvest-fixture";
import { recordedQuotaRead } from "./quota-read";

export const fixtureHome = "/home/tester";

export const fixtureHomeDirectory = join(import.meta.dir, "..", "fixtures", "session-logs", "home");

// No directory can be made under /dev/null, so the session log layers keep no copy inside the committed fixture home.
export const fixtureHomeEnvironment = { HOME: fixtureHomeDirectory, XDG_STATE_HOME: "/dev/null" } as const;

export const recordedNow = DateTime.makeUnsafe("2026-10-13T20:18:16Z");

const harnessOf = (relative: string): Harness => {
  if (relative.startsWith(".pi/")) return "pi";
  return relative.startsWith(".claude/") ? "claude-code" : "codex";
};

const fixtureLogPaths = (): ReadonlyArray<string> =>
  readdirSync(fixtureHomeDirectory, { recursive: true, encoding: "utf8" })
    .filter((relative) => relative.endsWith(".jsonl"))
    .toSorted();

// Pi dashes only the slashes of a cwd to name its log folder, and Claude Code dashes every other character too.
const piFolderOf = (path: string) => `--${path.slice(1).replaceAll("/", "-")}-`;

const claudeFolderOf = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");

const homeForms = (home: string): ReadonlyArray<readonly [string, string]> => [
  [fixtureHome, home],
  [piFolderOf(fixtureHome), piFolderOf(home)],
  [claudeFolderOf(fixtureHome), claudeFolderOf(home)],
];

export const relocated = (text: string, home: string): string =>
  homeForms(home).reduce((moved, [from, to]) => moved.replaceAll(from, to), text);

export const unrelocated = (text: string, home: string): string =>
  homeForms(home).reduce((moved, [from, to]) => moved.replaceAll(to, from), text);

export const copyFixtureHome = (home: string): void => {
  for (const relative of fixtureLogPaths()) {
    const target = join(home, relocated(relative, home));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, relocated(readFileSync(join(fixtureHomeDirectory, relative), "utf8"), home));
  }
};

const fixtureLogFiles = (): ReadonlyArray<LogFile> =>
  fixtureLogPaths()
    .map((relative) => {
      const records = logRecords(harnessOf(relative), readFileSync(join(fixtureHomeDirectory, relative), "utf8"));
      const times = records.flatMap((record) => ("at" in record ? [record.at] : []));
      return {
        path: `${fixtureHome}/${relative}`,
        harness: harnessOf(relative),
        modifiedAt: Math.max(0, ...times),
        records,
      };
    });

export const fixtureSessionView = (quotaFixture = "quota-axi/full.json", now = recordedNow): SessionQuotaView =>
  sessionViewOfQuota(fixture(quotaFixture), now);

// The recorded Claude five-hour window, read ahead of pace with 40 points left and running out before its reset, flags
// shop's pane there too over the same logs.
export const fiveHourAheadSessionView = (): SessionQuotaView =>
  sessionViewOfQuota(
    fixture("quota-axi/full.json")
      .replace(/"percentRemaining": 98,(\s*"pace": \{\s*"status": )"behind"/u, '"percentRemaining": 40,$1"ahead"')
      .replace(
        '"usableRunwaySeconds": 160614,\n              "projectedExhaustedAt": "2026-10-15T16:55:09.538Z",\n              "limitingWindowId": "seven_day"',
        '"usableRunwaySeconds": 2504,\n              "projectedExhaustedAt": "2026-10-13T21:00:00.000Z",\n              "limitingWindowId": "five_hour"',
      ),
    recordedNow,
  );

// The harness logs' fresh Codex readings stand in for quota-axi, and the Claude week's rejection is newer than its moved read.
export const harvestedSessionView = (quotaJson = readBeforeHarvest(fixture("quota-axi/full.json"))): SessionQuotaView =>
  sessionViewOfQuota(quotaJson, recordedNow, [rolloutFile(), claudeLogFile()]);

export const sessionViewOfQuota = (quotaJson: string, now: DateTime.Utc, extra: ReadonlyArray<LogFile> = []): SessionQuotaView => {
  const files = [...fixtureLogFiles(), ...extra];
  return sessionQuotaFrom({
    quota: recordedQuotaRead(quotaJson, now, files),
    savedProfiles: { ...decodeSavedProfiles(fixture("saved-profiles/status.json")), capturedAt: now },
    panes: decodeHerdrPanes(fixture("session-logs/herdr-agents.json")),
    processes: decodeLinuxHarnessProcesses(fixture("session-logs/harness-processes.txt")),
    logs: { home: fixtureHome, roots: homeLogRoots(fixtureHome), files, captured: nothingCaptured },
    now,
    timeZone: DateTime.zoneMakeNamedUnsafe("UTC"),
  });
};
