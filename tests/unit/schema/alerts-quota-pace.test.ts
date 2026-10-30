import { describe, expect, test } from "bun:test";
import { DateTime, Schema } from "effect";
import {
  AlertEvent,
  type ComposedSessionQuotaReport,
  composedSessionQuota,
  composedSessionQuotaReport,
  type Outcome,
  quotaPaceStart,
  quotaPaceStep,
} from "@tui-dash/schema";
import { machineView } from "../../lib/machines-fixture";

const fixtureReport = (): ComposedSessionQuotaReport => composedSessionQuotaReport(composedSessionQuota(machineView("north"), "north", []), "north");

const calmWeek = (report: ComposedSessionQuotaReport): ComposedSessionQuotaReport => ({
  ...report,
  flags: report.flags.filter((flag) => !(flag.window === "seven_day" && flag.account.provider === "claude")),
  windows: report.windows.map((window) =>
    window.account.provider === "claude" && window.id === "seven_day"
      ? { ...window, exhaustsBeforeReset: false, sessions: window.sessions.map((row) => ({ ...row, flagged: false })) }
      : window,
  ),
});

const runningOutWeek = (report: ComposedSessionQuotaReport): ComposedSessionQuotaReport => ({
  ...calmWeek(report),
  windows: calmWeek(report).windows.map((window) =>
    window.account.provider === "claude" && window.id === "seven_day" ? { ...window, exhaustsBeforeReset: true } : window,
  ),
});

const withoutClaude = (report: ComposedSessionQuotaReport): ComposedSessionQuotaReport => ({
  ...report,
  windows: report.windows.filter((window) => window.account.provider !== "claude"),
});

type Sample = Outcome<ComposedSessionQuotaReport>;

const read = (report: ComposedSessionQuotaReport): Sample => ({ kind: "ok", value: report });

const unread: Sample = { kind: "unreachable", reason: "quota gave no answer within 3m" };

const run = (samples: ReadonlyArray<Sample>) => {
  let state = quotaPaceStart;
  return samples.flatMap((sample, index) => {
    const stepped = quotaPaceStep(state, sample, DateTime.makeUnsafe(Date.parse("2026-10-19T09:00:00Z") + index * 60_000));
    state = stepped.state;
    return stepped.events.map((event) => ({ sample: index, event }));
  });
};

describe("the quota pace rule", () => {
  test("fires once for each window holding a flag or running out, and stays quiet while it holds", () => {
    const fired = run([read(fixtureReport()), read(fixtureReport()), read(fixtureReport())]);
    expect(fired.map(({ sample, event }) => [sample, event.account.provider, event.window])).toEqual([[0, "claude", "seven_day"]]);
  });

  test("stays quiet on a burst while the account is on track", () => {
    const burst = calmWeek(fixtureReport());
    expect(burst.windows.find((window) => window.id === "seven_day")?.gate.open).toBe(true);
    expect(run([read(burst), read(burst)])).toEqual([]);
  });

  test("fires on a window running out even with no session over its share", () => {
    const fired = run([read(runningOutWeek(fixtureReport()))]);
    expect(fired.map(({ sample, event }) => [sample, event.account.provider, event.window])).toEqual([[0, "claude", "seven_day"]]);
    expect(fired[0]?.event.flags).toEqual([]);
  });

  test("fires again once the window quiets and threatens again", () => {
    const open = read(fixtureReport());
    const quiet = read(calmWeek(fixtureReport()));
    expect(run([open, quiet, open, open]).map(({ sample }) => sample)).toEqual([0, 2]);
  });

  test("keeps the episode across a read that failed or that left the window out", () => {
    const open = read(fixtureReport());
    expect(run([open, unread, read(withoutClaude(fixtureReport())), open]).map(({ sample }) => sample)).toEqual([0]);
  });

  test("names the window, its pace figures and the flags on it in an event the alert schema reads back", () => {
    const fired = run([read(fixtureReport())]);
    expect(fired).toHaveLength(1);
    const event = fired[0].event;
    expect(Schema.decodeUnknownSync(AlertEvent)(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(event).toEqual({
      schemaVersion: 1,
      rule: "quota-pace",
      at: "2026-10-19T09:00:00.000Z",
      account: { provider: "claude", accountKey: "work", credentialKey: null, title: "claude work" },
      window: "seven_day",
      windowLabel: "Weekly",
      leftPoints: 40,
      elapsedFraction: fixtureReport().windows[1]?.elapsedFraction,
      resetsAt: "2026-10-19T20:00:00.000Z",
      flags: fixtureReport().flags,
    });
    expect(event.flags.map(({ session }) => session)).toEqual(["pane:w1"]);
  });
});
