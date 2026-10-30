import { describe, expect, test } from "bun:test";
import { DateTime, Schema } from "effect";
import {
  composedSessionQuota,
  SessionQuotaReport,
  sessionQuotaReport,
  type SessionQuotaView,
  sessionQuotaViewOf,
  type WindowView,
} from "@tui-dash/schema";
import { claudeKeyed, claudeUnread, machineReport, machineView, southReading } from "../../lib/machines-fixture";
import { issueOf, valueOf } from "../../lib/outcomes";
import { fixtureSessionView } from "../../lib/session-fixture";

const composed = (remote = southReading()) => composedSessionQuota(machineView("north"), "north", [remote]);

const windowOf = (view: SessionQuotaView, title: string, id: string): WindowView | undefined => {
  const body = view.accounts.find((account) => account.title === title)?.body;
  return body?.kind === "windows" ? body.windows.find((window) => window.id === id) : undefined;
};

const endedNotes = "file:/home/tester/.claude/projects/-home-tester-notes/bbbbbbbb-0000-4000-8000-00000000b001.jsonl";

const rowsOf = (window: WindowView | undefined) =>
  (window?.sessions ?? []).map((row) => ({
    machine: row.session.machine,
    session: row.session.id,
    priced: row.priced,
    raw: row.raw.share,
    flagged: row.flagged,
  }));

describe("a machine's version 1 report read back as a view", () => {
  test("prints the same report it was read from", () => {
    const report = sessionQuotaReport(fixtureSessionView());
    const reread = valueOf(sessionQuotaViewOf(Schema.decodeUnknownSync(SessionQuotaReport)(JSON.parse(JSON.stringify(report))), "north"));
    expect(sessionQuotaReport(reread)).toEqual(report);
  });

  test("names the field when a window row points at a session the report does not list", () => {
    const report = machineReport("south");
    const broken = { ...report, sessions: report.sessions.filter((session) => session.harness !== "pi") };
    expect(issueOf(sessionQuotaViewOf(broken, "south"))).toBe("windows[2].sessions[0] names no listed session");
  });

  test("names the field when an instant does not parse", () => {
    expect(issueOf(sessionQuotaViewOf({ ...machineReport("south"), generatedAt: "noon" }, "south"))).toBe(
      "generatedAt is not an instant",
    );
  });
});

describe("two machines' reports composed", () => {
  test("gives the shared Claude week one estimate, each session a share of both machines' calls", () => {
    const week = windowOf(composed(), "claude work", "seven_day");
    expect(rowsOf(week)).toEqual([
      { machine: "south", session: "pane:w1", priced: { share: 0.5, contributionPoints: 30, pointsPerHour: 30 }, raw: 0.2, flagged: true },
      { machine: "north", session: "pane:w1", priced: { share: 0.25, contributionPoints: 15, pointsPerHour: 15 }, raw: 0.5, flagged: true },
      { machine: "north", session: endedNotes, priced: { share: 0.25, contributionPoints: 15, pointsPerHour: 0 }, raw: 0.3, flagged: false },
    ]);
    expect([week?.observedCalls, week?.activeSessions, week?.fairPointsPerHour, week?.unattributedPoints]).toEqual([9, 2, 0.25, 0]);
  });

  test("splits the window's used points once rather than once per machine", () => {
    const alone = [machineView("north"), machineView("south")].map((view) =>
      rowsOf(windowOf(view, "claude work", "seven_day")).reduce((sum, row) => sum + row.priced.contributionPoints, 0),
    );
    const together = rowsOf(windowOf(composed(), "claude work", "seven_day")).reduce((sum, row) => sum + row.priced.contributionPoints, 0);
    expect(alone).toEqual([60, 60]);
    expect(together).toBe(60);
  });

  test("keeps a provider seen on one machine as that machine read it", () => {
    const view = composed();
    expect(view.accounts.map((account) => account.title)).toEqual(["claude work", "codex", "opencode-go"]);
    expect(rowsOf(windowOf(view, "codex", "weekly"))).toEqual([
      { machine: "north", session: "pid:4242", priced: { share: 1, contributionPoints: 10, pointsPerHour: 0 }, raw: 1, flagged: false },
    ]);
    expect(rowsOf(windowOf(view, "opencode-go", "monthly")).map((row) => [row.machine, row.priced.contributionPoints])).toEqual([
      ["south", 20],
    ]);
  });

  test("leaves a window two machines read in different cycles uncombined, and names the machine left out", () => {
    const fiveHour = windowOf(composed(), "claude work", "five_hour");
    expect([fiveHour?.resetsAt, fiveHour?.observedCalls, fiveHour?.otherCycle]).toEqual([
      DateTime.makeUnsafe("2026-10-16T17:00:00Z"),
      0,
      ["south"],
    ]);
  });

  test("joins both machines' joins on a shared account, and adds their ledgers, unmetered routes and unjoined calls", () => {
    const view = composed();
    expect(view.accounts.at(0)?.joins).toEqual([{ kind: "only-account" }, { kind: "default-account" }]);
    expect([view.ledger.bridgeCopiesDropped, view.ledger.repeatedLinesDropped, view.unjoinedCalls]).toEqual([1, 2, 1]);
    expect(view.unmetered).toEqual([{ route: "openai", calls: 3, tokens: { input: 30, output: 0, cacheRead: 0, cacheWrite: 0 } }]);
    expect(view.unmatched.map((runs) => [runs.machine, runs.pids])).toEqual([["south", [5150, 5151]]]);
  });
});

// A machine that read the shared five-hour window, opened at noon, at readAt, and whose one pane spent input tokens in its trailing hour.
const hourSpender = (machine: "north" | "south", readAt: string, input: number): SessionQuotaView => {
  const view = machineView(machine);
  const template = windowOf(machineView("north"), "claude work", "five_hour");
  const account = view.accounts.find((found) => found.title === "claude work");
  const session = view.sessions.find((found) => found.id === "pane:w1");
  if (template === undefined || account === undefined || session === undefined) throw new Error("the fixture lacks the shared window");
  const tokens = { input, output: 0, cacheRead: 0, cacheWrite: 0 };
  const nothing = { share: 0, contributionPoints: 0, pointsPerHour: 0 };
  const hoursLeft = (DateTime.toEpochMillis(template.resetsAt) - Date.parse("2026-10-16T12:31:00Z")) / 3_600_000;
  const window: WindowView = {
    ...template,
    usedPoints: 50,
    leftPoints: 50,
    sustainablePointsPerHour: 50 / hoursLeft,
    pace: "ahead",
    aheadOfPace: true,
    pastFirstTenth: true,
    observedCalls: 1,
    observedTokens: tokens,
    sessions: [
      {
        session,
        label: "w1",
        calls: 1,
        tokens,
        trailingHourTokens: tokens,
        raw: nothing,
        priced: nothing,
        models: [{ model: "claude-opus-5-5", calls: 1, tokens, trailingHourTokens: tokens, priced: nothing }],
        flagged: false,
      },
    ],
  };
  return { ...view, now: DateTime.makeUnsafe(readAt), accounts: [{ ...account, body: { kind: "windows", windows: [window] } }] };
};

describe("one shared account read under quota-axi's two spellings of a default key", () => {
  test("composes into one account whose shares split its used points once", () => {
    const north = machineView("north", claudeKeyed(null));
    const south = machineView("south", claudeKeyed("default"));
    const view = composedSessionQuota(north, "north", [southReading({ kind: "ok", value: south })]);
    expect(view.accounts.filter((account) => account.provider === "claude")).toHaveLength(1);
    const week = view.accounts.flatMap((account) =>
      account.provider === "claude" && account.body.kind === "windows" ? account.body.windows.filter((window) => window.id === "seven_day") : [],
    );
    expect(week).toHaveLength(1);
    expect(rowsOf(week.at(0)).reduce((sum, row) => sum + row.priced.contributionPoints, 0)).toBe(60);
  });
});

describe("an account one machine could not read", () => {
  const unread = "quota-axi gave claude work no windows";

  test("keeps the other machine's windows and names the machine and account that failed", () => {
    const view = composedSessionQuota(machineView("north", claudeUnread(unread)), "north", [southReading()]);
    expect(rowsOf(windowOf(view, "claude work", "seven_day")).map((row) => [row.machine, row.priced.contributionPoints])).toEqual([
      ["south", 60],
    ]);
    expect(view.composition?.failedAccounts).toEqual([
      {
        machine: "north",
        account: expect.objectContaining({ provider: "claude", accountKey: "work", title: "claude work" }),
        failure: { kind: "invalid", issue: unread },
      },
    ]);
  });

  test("names the remote when it is the machine that failed", () => {
    const view = composedSessionQuota(machineView("north"), "north", [
      southReading({ kind: "ok", value: machineView("south", claudeUnread(unread)) }),
    ]);
    expect(rowsOf(windowOf(view, "claude work", "seven_day")).map((row) => row.machine)).toEqual(["north", "north"]);
    expect(view.composition?.failedAccounts.map(({ machine, failure }) => [machine, failure])).toEqual([
      ["south", { kind: "invalid", issue: unread }],
    ]);
  });

  test("lists no failed account when every machine read every account", () => {
    expect(composed().composition?.failedAccounts).toEqual([]);
  });
});

describe("the flag across two machines", () => {
  test("flags only the session over the fair share both machines' burners split, not a fair share counted per machine", () => {
    const north = hourSpender("north", "2026-10-16T12:31:00Z", 60);
    const south = hourSpender("south", "2026-10-16T12:32:00Z", 6000);
    const view = composedSessionQuota(north, "north", [southReading({ kind: "ok", value: south })]);
    const fiveHour = windowOf(view, "claude work", "five_hour");
    expect(fiveHour?.activeSessions).toBe(2);
    expect(fiveHour?.fairPointsPerHour).toBeCloseTo(5.58, 2);
    expect(rowsOf(fiveHour).map((row) => [row.machine, row.priced.pointsPerHour, row.flagged])).toEqual([
      ["south", expect.closeTo(92.8, 1), true],
      ["north", expect.closeTo(0.96, 2), false],
    ]);
  });

  test("rates each session's models against the calls both machines observed", () => {
    const north = hourSpender("north", "2026-10-16T12:31:00Z", 60);
    const south = hourSpender("south", "2026-10-16T12:32:00Z", 6000);
    const fiveHour = windowOf(composedSessionQuota(north, "north", [southReading({ kind: "ok", value: south })]), "claude work", "five_hour");
    for (const row of fiveHour?.sessions ?? []) expect(row.models.map((model) => model.priced)).toEqual([row.priced]);
    expect(fiveHour?.sessions).toHaveLength(2);
  });
});

describe("a remote that adds nothing", () => {
  const northAlone = rowsOf(windowOf(machineView("north"), "claude work", "seven_day"));

  test("reads as stale past five minutes, and leaves this machine's upper bounds", () => {
    const old = { ...machineView("south"), now: DateTime.makeUnsafe("2026-10-16T11:50:00Z") };
    const view = composed(southReading({ kind: "ok", value: old }));
    expect(view.composition?.remotes).toEqual([{ name: "south", state: { kind: "stale", generatedAt: old.now } }]);
    expect(rowsOf(windowOf(view, "claude work", "seven_day"))).toEqual(northAlone);
    expect(view.accounts.map((account) => account.title)).toEqual(["claude work", "codex"]);
  });

  test("combines a report four minutes old", () => {
    const recent = { ...machineView("south"), now: DateTime.makeUnsafe("2026-10-16T11:56:00Z") };
    expect(composed(southReading({ kind: "ok", value: recent })).composition?.remotes.at(0)?.state.kind).toBe("ok");
  });

  test("keeps this machine's upper bounds when the remote command fails, and carries its reason", () => {
    const view = composed(southReading({ kind: "unreachable", reason: "sh exited 255: ssh: connect to host south.example.com port 22: Connection refused" }));
    expect(view.composition?.remotes.at(0)?.state).toEqual({
      kind: "unreachable",
      reason: "sh exited 255: ssh: connect to host south.example.com port 22: Connection refused",
    });
    expect(rowsOf(windowOf(view, "claude work", "seven_day"))).toEqual(northAlone);
    expect(view.sessions.every((session) => session.machine === "north")).toBe(true);
  });
});
