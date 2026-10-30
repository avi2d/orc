import { describe, expect, test } from "bun:test";
import { DateTime, Schema } from "effect";
import {
  ComposedSessionQuotaReport,
  composedSessionQuota,
  composedSessionQuotaReport,
  SessionQuotaAlert,
  sessionQuotaAlerts,
  type SessionQuotaFlag,
  SessionQuotaReport,
  sessionQuotaReport,
  sessionQuotaViewOf,
} from "@tui-dash/schema";
import { rolloutPath } from "../../lib/harvest-fixture";
import { claudeUnread, machineReport, machineView, southReading } from "../../lib/machines-fixture";
import { valueOf } from "../../lib/outcomes";
import { fixtureSessionView, harvestedSessionView, recordedNow } from "../../lib/session-fixture";

const report = () => sessionQuotaReport(fixtureSessionView());

describe("the session quota JSON contract, version 1", () => {
  test("survives a JSON round trip and decodes against its own published schema", () => {
    const decoded = Schema.decodeUnknownSync(SessionQuotaReport)(JSON.parse(JSON.stringify(report())));
    expect(decoded.schemaVersion).toBe(1);
    expect(decoded.scope).toBe("local");
    expect(decoded.estimate.upperBound).toBe(true);
  });

  test("decodes a 23:00 read of the five-hour window reset at 21:30 with no sustainable rate and no fair share", () => {
    const late = sessionQuotaReport(fixtureSessionView("quota-axi/full.json", DateTime.makeUnsafe("2026-10-14T23:00:00Z")));
    const decoded = Schema.decodeUnknownSync(SessionQuotaReport)(JSON.parse(JSON.stringify(late)));
    const fiveHour = decoded.windows.find((window) => window.account.title === "claude main" && window.id === "five_hour");
    expect([fiveHour?.sustainablePointsPerHour, fiveHour?.fairPointsPerHour]).toEqual([null, null]);
  });

  test("names every flag, each with its window, priced pace and fair share", () => {
    expect(report().flags.map((flag) => [flag.session, flag.account.title, flag.window])).toEqual([
      ["pane:w1A:p2", "claude main", "seven_day"],
      ["pane:w2B:p2", "claude main", "seven_day"],
      ["pid:4242", "claude main", "seven_day"],
      ["pane:w2B:p2", "opencode-go", "monthly"],
    ]);
    for (const flag of report().flags) expect(flag.pricedPointsPerHour).toBeGreaterThan(flag.fairPointsPerHour);
  });

  test("carries every tracked window with its gate, measured tokens and unattributed remainder", () => {
    const windows = report().windows.map((window) => [window.account.title, window.id, window.gate.open, window.unattributedPoints]);
    expect(windows).toEqual([
      ["claude main", "five_hour", false, 0],
      ["claude main", "seven_day", true, 0],
      ["codex", "five_hour", false, 0],
      ["codex", "weekly", false, 0],
      ["opencode-go", "rolling", false, 0],
      ["opencode-go", "weekly", false, 0],
      ["opencode-go", "monthly", true, 0],
    ]);
    const codex = report().windows.find((window) => window.account.title === "codex" && window.id === "weekly");
    expect(codex?.observed.tokens).toEqual({ input: 2400, output: 0, cacheRead: 9600, cacheWrite: 0, total: 12_000 });
  });

  test("reports every source as read", () => {
    expect(report().sources).toEqual({ quota: { status: "ok" }, herdr: { status: "ok" }, processes: { status: "ok" } });
  });

  test("names quota-axi as the source of every window it read last, with the recorded report's refreshedAt time", () => {
    expect(report().windows.map((window) => [window.account.title, window.id, window.source])).toEqual([
      ["claude main", "five_hour", { kind: "quota-axi", readAt: "2026-10-13T20:18:15.232Z" }],
      ["claude main", "seven_day", { kind: "quota-axi", readAt: "2026-10-13T20:18:15.232Z" }],
      ["codex", "five_hour", { kind: "quota-axi", readAt: "2026-10-13T20:18:15.337Z" }],
      ["codex", "weekly", { kind: "quota-axi", readAt: "2026-10-13T20:18:15.337Z" }],
      ["opencode-go", "rolling", { kind: "quota-axi", readAt: "2026-10-13T20:18:15.239Z" }],
      ["opencode-go", "weekly", { kind: "quota-axi", readAt: "2026-10-13T20:18:15.239Z" }],
      ["opencode-go", "monthly", { kind: "quota-axi", readAt: "2026-10-13T20:18:15.239Z" }],
    ]);
  });

  test("names a harness log as the source of each window it read later than quota-axi, with the 25 percent Codex week, the emptied Claude week and the credential-key versus only-account join", () => {
    const decoded = Schema.decodeUnknownSync(SessionQuotaReport)(JSON.parse(JSON.stringify(sessionQuotaReport(harvestedSessionView()))));
    const harvested = decoded.windows.filter((window) => window.source?.kind === "harvested");
    expect(harvested.map((window) => [window.account.title, window.id, window.usedPoints, window.source])).toEqual([
      [
        "claude main",
        "seven_day",
        100,
        {
          kind: "harvested",
          harness: "claude-code",
          via: "log",
          observedAt: "2026-10-13T20:00:00.000Z",
          file: "/home/tester/.claude/projects/-home-tester-notes/dddddddd-0000-4000-8000-00000000d101.jsonl",
          join: { kind: "only-account" },
        },
      ],
      [
        "codex",
        "five_hour",
        18.5,
        {
          kind: "harvested",
          harness: "codex",
          via: "log",
          observedAt: "2026-10-13T19:40:00.000Z",
          file: rolloutPath,
          join: { kind: "credential-key", key: "codex-home" },
        },
      ],
      [
        "codex",
        "weekly",
        25,
        {
          kind: "harvested",
          harness: "codex",
          via: "log",
          observedAt: "2026-10-13T19:40:00.000Z",
          file: rolloutPath,
          join: { kind: "credential-key", key: "codex-home" },
        },
      ],
    ]);
  });
});

const composedReport = (remote = southReading()) =>
  Schema.decodeUnknownSync(ComposedSessionQuotaReport)(
    JSON.parse(JSON.stringify(composedSessionQuotaReport(composedSessionQuota(machineView("north"), "north", [remote]), "north"))),
  );

describe("a version-1 north.json report from before window sources and credential keys", () => {
  test("still decodes, every window read by quota-axi at the 2026-10-16T12:00:00Z generation read", () => {
    const view = machineView("north");
    const sources = view.accounts.flatMap((account) => (account.body.kind === "windows" ? account.body.windows : [])).map((window) => window.source);
    expect(sources.length).toBeGreaterThan(0);
    expect(new Set(sources.map((source) => (source.kind === "quota-axi" ? DateTime.formatIso(source.readAt) : source.kind)))).toEqual(
      new Set(["2026-10-16T12:00:00.000Z"]),
    );
    expect(view.accounts.map((account) => account.credentialKey)).toEqual(view.accounts.map(() => undefined));
  });
});

const harvestedViaOf = (json: string) => {
  const view = valueOf(sessionQuotaViewOf(Schema.decodeUnknownSync(SessionQuotaReport)(JSON.parse(json)), "north"));
  return view.accounts
    .flatMap((account) => (account.body.kind === "windows" ? account.body.windows : []))
    .flatMap((window) => (window.source.kind === "harvested" ? [[window.source.harness, window.source.via]] : []));
};

describe("a pre-ledger version-1 report and the via of its harvested windows", () => {
  const written = JSON.stringify(sessionQuotaReport(harvestedSessionView()));

  test("reads a harvested window with no via as read from a log", () => {
    const beforeLedger = written.replaceAll('"via":"log",', "");
    expect(beforeLedger).not.toContain('"via"');
    expect(harvestedViaOf(beforeLedger)).toEqual([
      ["claude-code", "log"],
      ["codex", "log"],
      ["codex", "log"],
    ]);
  });

  test("reads a Claude window back as read from the statusline when the report says so", () => {
    const fromStatusline = written.replace('"harness":"claude-code","via":"log"', '"harness":"claude-code","via":"statusline"');
    expect(harvestedViaOf(fromStatusline)).toEqual([
      ["claude-code", "statusline"],
      ["codex", "log"],
      ["codex", "log"],
    ]);
  });

  test("reads a Claude window back as headless when the report says so", () => {
    const headless = written.replace('"harness":"claude-code","via":"log"', '"harness":"claude-code","via":"headless"');
    expect(harvestedViaOf(headless)).toEqual([
      ["claude-code", "headless"],
      ["codex", "log"],
      ["codex", "log"],
    ]);
  });
});

describe("the composed session quota JSON contract, version 2", () => {
  test("survives a JSON round trip and decodes against its own published schema", () => {
    const decoded = composedReport();
    expect([decoded.schemaVersion, decoded.scope, decoded.estimate.basis, decoded.estimate.upperBound]).toEqual([
      2,
      "composed",
      "machine-logs",
      true,
    ]);
  });

  // The version tells the two report shapes apart.
  test("is a different version from the single-machine report, and neither schema reads the other", () => {
    expect(Schema.is(SessionQuotaReport)(composedReport())).toBe(false);
    expect(Schema.is(ComposedSessionQuotaReport)(machineReport("north"))).toBe(false);
  });

  test("lists both machines, each read and combined", () => {
    expect(composedReport().machines).toEqual([
      {
        name: "north",
        role: "local",
        status: "ok",
        generatedAt: "2026-10-16T12:00:00.000Z",
        combined: true,
        sources: { quota: { status: "ok" }, herdr: { status: "ok" }, processes: { status: "ok" } },
        failedAccounts: [],
      },
      {
        name: "south",
        role: "remote",
        status: "ok",
        generatedAt: "2026-10-16T12:00:00.000Z",
        combined: true,
        sources: { quota: { status: "ok" }, herdr: { status: "ok" }, processes: { status: "ok" } },
        failedAccounts: [],
      },
    ]);
  });

  test("lists a Claude account south could not read on south alone, while the merged account carries the other's windows", () => {
    const unread = machineView("south", claudeUnread("quota-axi gave claude work no windows"));
    const decoded = composedReport(southReading({ kind: "ok", value: unread }));
    expect(decoded.machines.map((machine) => [machine.name, machine.failedAccounts])).toEqual([
      ["north", []],
      [
        "south",
        [
          {
            provider: "claude",
            accountKey: "work",
            credentialKey: null,
            title: "claude work",
            quota: { status: "invalid", detail: "quota-axi gave claude work no windows" },
          },
        ],
      ],
    ]);
    expect(decoded.accounts.find((account) => account.title === "claude work")?.quota).toEqual({ status: "ok" });
  });

  test("puts each session, window row, flag and unmatched folder on its machine", () => {
    const composed = composedReport();
    const week = composed.windows.find((window) => window.account.title === "claude work" && window.id === "seven_day");
    expect(week?.sessions.map((row) => [row.machine, row.session])).toEqual([
      ["south", "pane:w1"],
      ["north", "pane:w1"],
      ["north", "file:/home/tester/.claude/projects/-home-tester-notes/bbbbbbbb-0000-4000-8000-00000000b001.jsonl"],
    ]);
    expect(composed.flags.map((flag) => [flag.machine, flag.session, flag.window])).toEqual([
      ["south", "pane:w1", "seven_day"],
      ["north", "pane:w1", "seven_day"],
    ]);
    expect(composed.unmatchedProcesses.map((runs) => [runs.machine, runs.pids])).toEqual([["south", [5150, 5151]]]);
    expect(composed.sessions.map((session) => session.machine)).toEqual(["north", "north", "north", "south", "south"]);
  });

  test("names the machine a window was read in another cycle on", () => {
    const fiveHour = composedReport().windows.find((window) => window.id === "five_hour");
    expect([fiveHour?.resetsAt, fiveHour?.otherCycle]).toEqual(["2026-10-16T17:00:00.000Z", ["south"]]);
  });

  test("marks a stale remote uncombined with the instant it answered", () => {
    const old = { ...machineView("south"), now: DateTime.makeUnsafe("2026-10-16T11:50:00Z") };
    expect(composedReport(southReading({ kind: "ok", value: old })).machines.at(1)).toEqual({
      name: "south",
      role: "remote",
      status: "stale",
      generatedAt: "2026-10-16T11:50:00.000Z",
      combined: false,
      sources: null,
      failedAccounts: [],
    });
  });

  test("reads as this machine's alone when no remote composed it", () => {
    const alone = composedSessionQuotaReport(machineView("north"), "north");
    expect(alone.machines.map((machine) => machine.name)).toEqual(["north"]);
    expect(alone.flags.map((flag) => [flag.machine, flag.session])).toEqual([["north", "pane:w1"]]);
  });
});

const flag = (session: string, window: string): SessionQuotaFlag => ({
  session,
  label: session,
  account: { provider: "claude", accountKey: null, credentialKey: "default", title: "claude" },
  window,
  windowLabel: window,
  pricedPointsPerHour: 2,
  fairPointsPerHour: 1,
  pricedShare: 0.5,
  rawShare: 0.5,
});

describe("the session quota alert stream", () => {
  test("raises a flag once, stays quiet while it holds, and clears it once", () => {
    const raised = sessionQuotaAlerts([], [flag("pane:a", "seven_day")], recordedNow);
    const held = sessionQuotaAlerts([flag("pane:a", "seven_day")], [flag("pane:a", "seven_day")], recordedNow);
    const cleared = sessionQuotaAlerts([flag("pane:a", "seven_day")], [], DateTime.makeUnsafe("2026-10-13T20:48:16Z"));
    expect(raised.map((alert) => [alert.event, alert.flag.session, alert.at])).toEqual([
      ["flagged", "pane:a", "2026-10-13T20:18:16.000Z"],
    ]);
    expect(held).toEqual([]);
    expect(cleared.map((alert) => [alert.event, alert.at])).toEqual([["cleared", "2026-10-13T20:48:16.000Z"]]);
  });

  test("treats a flag moving to another session as one flag cleared and one raised", () => {
    const moved = sessionQuotaAlerts([flag("pane:a", "seven_day")], [flag("pane:b", "seven_day")], recordedNow);
    expect(moved.map((alert) => [alert.event, alert.flag.session])).toEqual([
      ["flagged", "pane:b"],
      ["cleared", "pane:a"],
    ]);
    for (const alert of moved) expect(Schema.is(SessionQuotaAlert)(alert)).toBe(true);
  });
});
