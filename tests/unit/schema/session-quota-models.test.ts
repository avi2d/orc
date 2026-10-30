import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import type { CountedCall, ModelTokens } from "@tui-dash/schema";
import { composedSessionQuota, sessionQuotaReport, sessionQuotaViewOf } from "@tui-dash/schema";
import { valueOf } from "../../lib/outcomes";
import { call, fifthIn, hour, reset, six, viewOf, windowOf } from "../../lib/quota-view-fixture";

const [a] = six;

describe("sessionQuotaView per model of each session", () => {
  const calls: ReadonlyArray<CountedCall> = [
    call(a, fifthIn - 10 * 60_000, 3000),
    { ...call(a, fifthIn - 2 * hour, 1000), model: "claude-sonnet-5-5", tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 } },
  ];
  const row = () => windowOf(viewOf({ now: fifthIn, weekStatus: "on_pace", weekLeft: 60 }, [a], calls), "claude", "seven_day").sessions.at(0);

  test("splits a session's tokens and points across its models, the model with the most tokens first", () => {
    expect(row()?.models).toEqual([
      {
        model: "claude-opus-5-5",
        calls: 1,
        tokens: { input: 3000, output: 0, cacheRead: 0, cacheWrite: 0 },
        trailingHourTokens: { input: 3000, output: 0, cacheRead: 0, cacheWrite: 0 },
        priced: { share: 0.6, contributionPoints: 24, pointsPerHour: 24 },
      },
      {
        model: "claude-sonnet-5-5",
        calls: 1,
        tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
        trailingHourTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        priced: { share: 0.4, contributionPoints: 16, pointsPerHour: 0 },
      },
    ]);
  });

  test("adds its models' points up to the session's own", () => {
    const models = row()?.models ?? [];
    expect(models.reduce((sum, model) => sum + model.priced.contributionPoints, 0)).toBeCloseTo(row()?.priced.contributionPoints ?? Number.NaN, 9);
    expect(models.reduce((sum, model) => sum + model.priced.pointsPerHour, 0)).toBeCloseTo(row()?.priced.pointsPerHour ?? Number.NaN, 9);
  });

  test("keeps the calls whose log names no model in one row of their own, null in the report", () => {
    const unnamed = [...calls, { ...call(a, fifthIn - 20 * 60_000, 500), model: undefined }];
    const view = viewOf({ now: fifthIn, weekStatus: "on_pace", weekLeft: 60 }, [a], unnamed);
    expect(windowOf(view, "claude", "seven_day").sessions.at(0)?.models.map((model) => [model.model, model.calls])).toEqual([
      ["claude-opus-5-5", 1],
      ["claude-sonnet-5-5", 1],
      [undefined, 1],
    ]);
    const reported = sessionQuotaReport(view).windows.find((window) => window.id === "seven_day")?.sessions.at(0)?.models;
    expect(reported?.map((model) => model.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", null]);
  });

  test("reads a report's models back, and a row written before models as having none", () => {
    const report = sessionQuotaReport(viewOf({ now: fifthIn, weekStatus: "on_pace", weekLeft: 60 }, [a], calls));
    const back = (read: typeof report) => {
      const account = valueOf(sessionQuotaViewOf(read, "north")).accounts.find((found) => found.provider === "claude");
      const week = account?.body.kind === "windows" ? account.body.windows.find((window) => window.id === "seven_day") : undefined;
      return week?.sessions.at(0)?.models.map((model) => [model.model, model.priced.contributionPoints]);
    };
    expect(back(report)).toEqual([
      ["claude-opus-5-5", 24],
      ["claude-sonnet-5-5", 16],
    ]);
    const legacy = { ...report, windows: report.windows.map((window) => ({ ...window, sessions: window.sessions.map(({ models: _, ...kept }) => kept) })) };
    expect(back(legacy)).toEqual([]);
  });
});

describe("sessionQuotaView per model since local midnight, not the window, UTC midnight or every call read", () => {
  const now = reset + 3 * hour;
  const timeZone = DateTime.zoneMakeOffset(3 * hour);
  const calls: ReadonlyArray<CountedCall> = [
    { ...call(a, now - 24 * hour, 200_000), model: "claude-haiku-5-5" },
    call(a, now - 22 * hour, 100_000),
    { ...call(a, now - hour, 10_000), model: "claude-sonnet-5-5" },
  ];
  const view = () => viewOf({ now, weekStatus: "on_pace", weekLeft: 60, timeZone }, [a], calls);
  const today = (models: ReadonlyArray<ModelTokens>) => models.map((model) => [model.model, model.tokens.input]);

  test("counts each model of a session since local midnight across a reset, and its window models only after it", () => {
    const read = view();
    expect(read.modelsSinceMidnight.map((entry) => [entry.session.id, today(entry.models)])).toEqual([
      ["pane:a", [["claude-opus-5-5", 100_000], ["claude-sonnet-5-5", 10_000]]],
    ]);
    expect(windowOf(read, "claude", "seven_day").sessions.at(0)?.models.map((model) => [model.model, model.tokens.input])).toEqual([
      ["claude-sonnet-5-5", 10_000],
    ]);
  });

  test("keeps them through the report, a peer reading it back, and two machines composed", () => {
    const report = sessionQuotaReport(view());
    expect(report.sessions.map((session) => session.modelsSinceMidnight?.map((model) => [model.model, model.tokens.total]))).toEqual([
      [["claude-opus-5-5", 100_000], ["claude-sonnet-5-5", 10_000]],
    ]);
    const south = valueOf(sessionQuotaViewOf(report, "south"));
    const composed = composedSessionQuota(view(), "north", [{ name: "south", reading: { kind: "ok", value: south } }]);
    expect(composed.modelsSinceMidnight.map((entry) => [entry.session.machine, today(entry.models)])).toEqual(
      ["north", "south"].map((machine) => [machine, [["claude-opus-5-5", 100_000], ["claude-sonnet-5-5", 10_000]]]),
    );
  });

  test("reads a report written before them as naming no model since midnight", () => {
    const report = sessionQuotaReport(view());
    const legacy = { ...report, sessions: report.sessions.map(({ modelsSinceMidnight: _, ...kept }) => kept) };
    expect(valueOf(sessionQuotaViewOf(legacy, "south")).modelsSinceMidnight).toEqual([]);
  });
});
