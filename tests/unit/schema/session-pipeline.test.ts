import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { type SessionQuotaView, type WindowView } from "@tui-dash/schema";
import { fixtureHome, fixtureSessionView, recordedNow } from "../../lib/session-fixture";

const windowOf = (view: SessionQuotaView, title: string, id: string): WindowView => {
  const account = view.accounts.find((candidate) => candidate.title === title);
  if (account?.body.kind !== "windows") throw new Error(`no ${title} windows`);
  const window = account.body.windows.find((candidate) => candidate.id === id);
  if (window === undefined) throw new Error(`no ${title} ${id}`);
  return window;
};

const flaggedIn = (window: WindowView): ReadonlyArray<string> =>
  window.sessions.filter((row) => row.flagged).map((row) => row.session.id);

const piFile = (folder: string, name: string) => `${fixtureHome}/.pi/agent/sessions/--home-tester-${folder}--/${name}.jsonl`;

const endedNotes = `file:${fixtureHome}/.claude/projects/-home-tester-notes/dddddddd-0000-4000-8000-00000000d001.jsonl`;

const endedShop = `file:${piFile(".treehouse-shop-a1b2c3-2-shop", "2026-10-10T08-00-00-000Z_eeeeeeee-0000-4000-8000-00000000e001")}`;

const endedCodex = `file:${fixtureHome}/.codex/sessions/2026/10/13/rollout-2026-10-13T10-00-00-ffffffff-0000-4000-8000-00000000f001.jsonl`;

describe("the session pipeline over the recorded fixture home", () => {
  const view = () => fixtureSessionView();

  test("names each pane, the headless run and every ended log as one session, and nothing else", () => {
    expect(view().sessions.map((session) => session.id).toSorted()).toEqual(
      ["pane:w1A:p2", "pane:w2B:p2", "pid:4242", endedNotes, endedShop, endedCodex].toSorted(),
    );
  });

  test("matches the lone headless run, and notes no pane's own process as unmatched", () => {
    expect(view().unmatched).toEqual([]);
  });

  test("labels the pane by its pool slot and the headless run by its pipeline run", () => {
    const labels = new Map(view().sessions.map((session) => [session.id, session.place]));
    expect(labels.get("pane:w1A:p2")).toBe("shop-a1b2c3/1");
    expect(labels.get("pane:w2B:p2")).toBe("~/my-home");
    expect(labels.get("pid:4242")).toBe("no-mistakes 0RUN42");
  });

  test("drops the bridge twin, the repeated lines, the synthetic row, the fork copy and the repeated Codex count", () => {
    expect(view().ledger).toEqual({
      bridgeCopiesDropped: 1,
      repeatedLinesDropped: 3,
      emptyRowsDropped: 1,
      forkCopiesDropped: 1,
      repeatedCountsDropped: 1,
    });
  });

  // The fair share is the 31 points the week has left over its hours to reset, split among the three live burners.
  test("flags every live session over its fair share of the Claude week, which is ahead and past its first tenth", () => {
    const week = windowOf(view(), "claude main", "seven_day");
    const hoursLeft = (Date.parse("2026-10-16T17:00:00.123738Z") - DateTime.toEpochMillis(recordedNow)) / 3_600_000;
    expect(week.fairPointsPerHour).toBeCloseTo(31 / hoursLeft / 3, 9);
    expect(flaggedIn(week)).toEqual(["pane:w1A:p2", "pane:w2B:p2", "pid:4242"]);
    expect(flaggedIn(windowOf(view(), "claude main", "five_hour"))).toEqual([]);
  });

  test("flags nothing on the Codex week, which is ahead but inside its first tenth", () => {
    const week = windowOf(view(), "codex", "weekly");
    expect(week.aheadOfPace).toBe(true);
    expect(week.pastFirstTenth).toBe(false);
    expect(flaggedIn(week)).toEqual([]);
    expect(week.observedCalls).toBe(2);
    expect(week.observedTokens).toEqual({ input: 2400, output: 0, cacheRead: 9600, cacheWrite: 0 });
  });

  test("flags the one live OpenCode spender on the month, and keeps the ended session's larger share first", () => {
    const month = windowOf(view(), "opencode-go", "monthly");
    expect(month.sessions.map((row) => row.session.id)).toEqual([endedShop, "pane:w2B:p2"]);
    expect(month.sessions.map((row) => row.priced.share)).toEqual([85_500 / 125_500, 40_000 / 125_500]);
    expect(month.sessions.map((row) => row.raw.share)).toEqual([233_500 / 339_100, 105_600 / 339_100]);
    expect(flaggedIn(month)).toEqual(["pane:w2B:p2"]);
  });

  test("rates the flagged OpenCode session against its fair share of what the month has left", () => {
    const month = windowOf(view(), "opencode-go", "monthly");
    const hoursLeft = (Date.parse("2026-11-08T10:51:51Z") - DateTime.toEpochMillis(recordedNow)) / 3_600_000;
    expect(month.sessions[1]?.priced.pointsPerHour).toBeCloseTo((40_000 * 19) / 125_500, 9);
    expect(month.fairPointsPerHour).toBeCloseTo(81 / hoursLeft, 9);
  });

  test("names the model of every session's calls in each window", () => {
    const modelsIn = (window: WindowView) => window.sessions.map((row) => [row.session.id, row.models.map((model) => model.model)]);
    expect(modelsIn(windowOf(view(), "claude main", "seven_day"))).toEqual([
      ["pane:w1A:p2", ["claude-opus-5-5"]],
      ["pane:w2B:p2", ["claude-opus-5-5"]],
      [endedNotes, ["claude-opus-5-5"]],
      ["pid:4242", ["claude-opus-5-5"]],
    ]);
    expect(modelsIn(windowOf(view(), "opencode-go", "monthly"))).toEqual([
      [endedShop, ["glm-5"]],
      ["pane:w2B:p2", ["glm-5"]],
    ]);
    expect(modelsIn(windowOf(view(), "codex", "weekly"))).toEqual([[endedCodex, [undefined]]]);
  });

  test("keeps the API-billed call apart from every subscription", () => {
    expect(view().unmetered).toEqual([
      { route: "openai", calls: 1, tokens: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 } },
    ]);
  });
});
