import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Option } from "effect";
import { caption, flagLines, sessionLines, sessionPanelLines, sessionPanelWithin } from "@tui-dash/session-quota";
import { createTestRenderer } from "@opentui/core/testing";
import { TextRenderable } from "@opentui/core";
import { type SessionQuotaView } from "@tui-dash/schema";
import { blockDocument, failureLines, frameText, lineWidth, plain } from "@tui-dash/ui";
import { fixture } from "../../lib/fixtures";
import {
  fixtureSessionView,
  harvestedSessionView,
  recordedNow,
  sessionViewOfQuota,
  fiveHourAheadSessionView,
} from "../../lib/session-fixture";

const rendered = (width: number) => {
  const rows = sessionLines(fixtureSessionView(), width, 8);
  return Effect.runPromise(frameText(blockDocument(rows), width, rows.length + 1));
};

const normalize = (frame: string): string =>
  frame
    .split("\n")
    .map((row) => row.trimEnd())
    .join("\n")
    .trimEnd();

describe("the session quota panel, against its pinned screens of the fixture home", () => {
  test("renders the reviewed 84 column screen through OpenTUI", async () => {
    expect(await rendered(84)).toBe(normalize(fixture("screens/session-quota-84x24.txt")));
  });

  test("renders the reviewed 40 column screen through OpenTUI", async () => {
    expect(await rendered(40)).toBe(normalize(fixture("screens/session-quota-40x31.txt")));
  });
});

describe("the session quota panel at every width from 30 to 120 columns", () => {
  const widths = Array.from({ length: 91 }, (_, index) => 30 + index);

  test("keeps every row inside the width", () => {
    for (const width of widths) {
      for (const line of sessionLines(fixtureSessionView(), width)) expect(lineWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test("always says the numbers are estimates, upper bounds and never quota, whole", () => {
    for (const width of widths) {
      const text = sessionLines(fixtureSessionView(), width).map(plain).join(" ");
      for (const phrase of caption.split(", ")) expect(text).toContain(phrase);
    }
  });

  test("tells every session row apart by its pane, pid or log id", () => {
    for (const width of widths) {
      const rows = sessionLines(fixtureSessionView(), width).map(plain).filter((row) => /^[●○⚑] .*%/u.test(row));
      for (const row of rows) expect(row).toMatch(/(w\dA:p2|w\dB:p2|pid 4242|#00[a-f0-9]{4}) /u);
    }
  });
});

describe("the session quota panel's upper bounds", () => {
  test("never prints a bound under the points a row's priced estimate gives it", () => {
    const view = fixtureSessionView();
    const estimates = view.accounts.flatMap((account) =>
      account.body.kind === "windows"
        ? account.body.windows.flatMap((window) => window.sessions.map((row) => row.priced.contributionPoints))
        : [],
    );
    const printed = sessionLines(view, 84)
      .map(plain)
      .flatMap((row) => /≤(\d+(?:\.\d)?)/u.exec(row)?.slice(1) ?? [])
      .map(Number);
    expect(printed).toHaveLength(estimates.length);
    for (const [index, bound] of printed.entries()) expect(bound).toBeGreaterThanOrEqual(estimates[index] ?? Number.NaN);
  });
});

const noted = () => ({
  ...fixtureSessionView(),
  unmatched: [{ harness: "pi" as const, cwd: "/home/tester/proj", place: "~/proj", pids: [7001, 7002] }],
});

describe("the session quota panel's rows", () => {
  const rows = () => sessionLines(fixtureSessionView(), 84).map(plain);

  test("says an account has no windows reported when quota-axi gave none with a pace, as quota-rows pins it, not a bare heading", () => {
    const unpaced = JSON.stringify(JSON.parse(fixture("quota-axi/full.json"), (key, value) => (key === "pace" ? undefined : value)));
    const lines = sessionLines(sessionViewOfQuota(unpaced, recordedNow), 84).map(plain);
    const heading = lines.findIndex((row) => row.startsWith("● claude"));
    expect(lines.slice(heading + 1, heading + 2)).toEqual(["no windows reported"]);
  });

  test("marks a flagged row, and only a flagged one, with the flag", () => {
    expect(rows().filter((row) => row.startsWith("⚑"))).toEqual([
      expect.stringContaining("shop-a1b2c3/1 w1A:p2"),
      expect.stringContaining("~/my-home w2B:p2"),
      expect.stringContaining("no-mistakes 0RUN42 pid 4242"),
      expect.stringContaining("~/my-home w2B:p2"),
    ]);
  });

  test("keeps a flagged row in view when the cap leaves room for one row a window", () => {
    const month = sessionLines(fixtureSessionView(), 84, 1).map(plain);
    const start = month.findIndex((row) => row.startsWith("31d window"));
    expect(month[start + 1]).toStartWith("⚑ ~/my-home w2B:p2");
    expect(month[start + 2]).toBe("  +1 more sessions");
  });

  test("keeps every flagged row in view, in rank order, when the Claude week flags three of four beyond the cap", () => {
    const capped = sessionLines(fixtureSessionView(), 84, 1).map(plain);
    const start = capped.findIndex((row) => row.startsWith("7d window 69pp"));
    expect(capped.slice(start + 1, start + 5).map((row) => row.slice(0, 32).trimEnd())).toEqual([
      "⚑ shop-a1b2c3/1 w1A:p2",
      "⚑ ~/my-home w2B:p2",
      "⚑ no-mistakes 0RUN42 pid 4242",
      "  +1 more sessions",
    ]);
  });

  test("leaves only the caption and each flag, with its window and rate against fair share, below one row a window", () => {
    expect(flagLines(fixtureSessionView(), 60, 24).map(plain)).toEqual([
      "estimates from local logs, upper bounds, never quota",
      "⚑ shop-a1b2c3/1 w1A:p2 · claude main 7d window",
      "  30.8pp/h, fair 0.15",
      "⚑ ~/my-home w2B:p2 · claude main 7d window",
      "  2.38pp/h, fair 0.15",
      "⚑ no-mistakes 0RUN42 pid 4242 · claude main 7d window",
      "  4.89pp/h, fair 0.15",
      "⚑ ~/my-home w2B:p2 · opencode-go 31d window",
      "  6.06pp/h, fair 0.13",
    ]);
  });

  test("keeps a gap between the bound and a rate of 100pp/h or more so the reported ≤73109.2 row reads as ≤73 then the rate", () => {
    const fastest = (pointsPerHour: number): SessionQuotaView => {
      const view = fixtureSessionView();
      return {
        ...view,
        accounts: view.accounts.map((account) =>
          account.body.kind === "windows"
            ? {
                ...account,
                body: {
                  ...account.body,
                  windows: account.body.windows.map((window) => ({
                    ...window,
                    sessions: window.sessions.map((row) =>
                      row.flagged ? { ...row, priced: { ...row.priced, pointsPerHour } } : row,
                    ),
                  })),
                },
              }
            : account,
        ),
      };
    };
    for (const width of [84, 40]) {
      const flagged = (pointsPerHour: number) =>
        sessionLines(fastest(pointsPerHour), width).map(plain).filter((row) => row.startsWith("⚑"));
      for (const row of flagged(109.2)) expect(row).toMatch(/ ≤\d+(\.\d)? +109$/u);
      for (const row of flagged(1234.5)) expect(row).toMatch(/ ≤\d+(\.\d)? +>999$/u);
      expect(flagged(109.2)).toHaveLength(4);
    }
  });

  test("says no session is flagged when none is", () => {
    const view = fixtureSessionView();
    const quiet = {
      ...view,
      accounts: view.accounts.map((account) =>
        account.body.kind === "windows"
          ? {
              ...account,
              body: {
                ...account.body,
                windows: account.body.windows.map((window) => ({
                  ...window,
                  sessions: window.sessions.map((row) => ({ ...row, flagged: false })),
                })),
              },
            }
          : account,
      ),
    };
    expect(flagLines(quiet, 60, 24).map(plain)).toEqual([
      "estimates from local logs, upper bounds, never quota",
      "no session flagged",
    ]);
  });

  test("keeps the shared folder whole at 40 columns instead of the reported ~/p… cut and names a lone pid in the singular", () => {
    const sharing = (pids: ReadonlyArray<number>): SessionQuotaView => ({
      ...fixtureSessionView(),
      unmatched: [{ harness: "pi", cwd: "/home/tester/proj", place: "~/proj", pids }],
    });
    expect(sessionLines(sharing([23973, 23977]), 40).map(plain).slice(2, 4)).toEqual([
      "! pids 23973 23977 share pi logs",
      "  in ~/proj, so those logs read as ended",
    ]);
    expect(sessionLines(sharing([1234567, 1234568]), 40).map(plain).slice(2, 4)).toEqual([
      "! pids 1234567 1234568 share pi logs",
      "  in ~/proj, so those logs read as ended",
    ]);
    expect(sessionLines(sharing([109993]), 84).map(plain).at(1)).toBe(
      "! pid 109993 shares pi logs in ~/proj, so those logs read as ended",
    );
  });

  test("shows no fair share on a 23:00 read of the five-hour window reset at 21:30", () => {
    const readLate = fixture("quota-axi/full.json").replace('"refreshedAt": "2026-10-13T20:18:15.232Z"', '"refreshedAt": "2026-10-14T22:59:00.000Z"');
    const quiet = sessionViewOfQuota(readLate, DateTime.makeUnsafe("2026-10-14T23:00:00Z"));
    expect(sessionLines(quiet, 84).map(plain)).toContain("5h window 2pp used · unknown pace");
  });

  test("notes headless runs that share a log folder, whose logs read as ended", () => {
    expect(sessionLines(noted(), 84).map(plain).slice(0, 2)).toEqual([
      "estimates from local logs, upper bounds, never quota",
      "! pids 7001 7002 share pi logs in ~/proj, so those logs read as ended",
    ]);
    expect(sessionLines(noted(), 40).map(plain).slice(2, 4)).toEqual([
      "! pids 7001 7002 share pi logs in ~/proj",
      "  so those logs read as ended",
    ]);
  });

  test("says none is over fair share, not a flag, on an open gate whose rows carry no flag", () => {
    const view = fixtureSessionView();
    const unflagged = {
      ...view,
      accounts: view.accounts.map((account) =>
        account.body.kind === "windows"
          ? {
              ...account,
              body: {
                ...account.body,
                windows: account.body.windows.map((window) => ({
                  ...window,
                  sessions: window.sessions.map((row) => ({ ...row, flagged: false })),
                })),
              },
            }
          : account,
      ),
    };
    const text = sessionLines(unflagged, 84).map(plain);
    expect(text.filter((row) => row.includes("over fair share flagged"))).toEqual([]);
    expect(text.filter((row) => row.includes("ahead of pace, none over fair share"))).toHaveLength(2);
  });

  test("says a gate-open window lasts to its reset when it is not running out, as the healthy month with burners at multiples of fair unflagged", () => {
    const view = fixtureSessionView();
    const lasting = {
      ...view,
      accounts: view.accounts.map((account) =>
        account.body.kind === "windows"
          ? {
              ...account,
              body: {
                ...account.body,
                windows: account.body.windows.map((window) => ({
                  ...window,
                  exhaustsBeforeReset: false,
                  sessions: window.sessions.map((row) => ({ ...row, flagged: false })),
                })),
              },
            }
          : account,
      ),
    };
    const text = sessionLines(lasting, 84).map(plain);
    expect(text.filter((row) => row.includes("over fair share flagged"))).toEqual([]);
    expect(text.filter((row) => row.includes("ahead of pace, lasts to reset"))).toHaveLength(2);
    expect(text.filter((row) => row.includes("none over fair share"))).toEqual([]);
  });

  test("puts the notes after the flags once only the flags fit, and counts the notes it leaves out", () => {
    expect(flagLines(noted(), 60, 6).map(plain)).toEqual([
      "estimates from local logs, upper bounds, never quota",
      "⚑ shop-a1b2c3/1 w1A:p2 7d claude main · 30.8pp/h, fair 0.15",
      "⚑ ~/my-home w2B:p2 7d claude main · 2.38pp/h, fair 0.15",
      "⚑ no-mistakes 0RUN42 pid 4242 7d claude main",
      "⚑ ~/my-home w2B:p2 31d opencode-go · 6.06pp/h, fair 0.13",
      "+2 more rows",
    ]);
  });

  // The account heading already names the join, so a window names only its points' source.
  test("names the harness log a window's used points came from, and its join only where the heading does not", () => {
    const wide = sessionLines(harvestedSessionView(), 84).map(plain);
    expect(wide).toContain("5h window 19pp used · from codex rollout 38m ago · fair 23.1pp/h each · behind pace");
    expect(wide).toContain("7d window 100pp used · from claude code log 18m ago · fair 0.00pp/h each");
    expect(wide.filter((row) => row.includes("joined by credential key"))).toEqual(["● codex · joined by credential key"]);
    const narrow = sessionLines(harvestedSessionView(), 40).map(plain);
    const fiveHour = narrow.indexOf("5h window 19pp used");
    expect(narrow.slice(fiveHour, fiveHour + 3)).toEqual([
      "5h window 19pp used",
      "from codex rollout 38m ago",
      "fair 23.1pp/h each · behind pace",
    ]);
  });

  // quota-axi is only the fallback, so its failure fails only the providers it was asked about.
  test("keeps the rollout's Codex windows beside a failed quota-axi read, in the full and the compact panel", () => {
    const view = harvestedSessionView("quota-axi is not on the PATH");
    if (view.quota === undefined) throw new Error("expected a failed quota-axi read");
    const failure = failureLines(view.quota, 84).map(plain);
    const wide = sessionLines(view, 84).map(plain);
    expect(wide).toContain("● codex · joined by credential key");
    expect(wide).toContain("5h window 19pp used · from codex rollout 38m ago · fair 23.1pp/h each · behind pace");
    const headings = wide.filter((row) => row.startsWith("● ")).map((row) => wide.indexOf(row));
    expect(headings.map((index) => wide[index])).toEqual([
      "● claude main · assumed the only login",
      "● codex · joined by credential key",
      "● opencode-go · assumed the only login",
    ]);
    for (const index of [headings[0] ?? 0, headings[2] ?? 0]) {
      expect(wide.slice(index + 1, index + 1 + failure.length)).toEqual(failure);
    }
    expect(flagLines(view, 84, 24).map(plain)).toEqual([
      caption,
      "no session flagged",
      "! no quota-axi reading, so calls on the accounts it reads are not counted",
      "  the output is not JSON",
    ]);
  });

  test("keeps the compact panel within its rows beside a failed quota-axi read, giving up the note's rows first", () => {
    const reason = "quota-axi timed out after 25 seconds while the vendor endpoints for Claude and OpenCode Go kept every connection open";
    const view = { ...harvestedSessionView("quota-axi is not on the PATH"), quota: { kind: "unreachable" as const, reason } };
    const roomy = 6;
    for (let budget = 2; budget <= roomy; budget += 1) {
      const lines = flagLines(view, 60, budget).map(plain);
      expect(lines.length).toBeLessThanOrEqual(budget);
      expect(lines.slice(0, 2)).toEqual([caption, "no session flagged"]);
    }
    expect(flagLines(view, 60, roomy).map(plain)).toEqual([
      caption,
      "no session flagged",
      "! no quota-axi reading",
      "  so calls on the accounts it reads are not counted",
      "  quota-axi timed out after 25 seconds while the vendor",
      "  endpoints for Claude and OpenCode Go kept every connectio…",
    ]);
  });

  test("shows the scanning state, still captioned, before the first read finishes", () => {
    expect(sessionPanelLines(Option.none(), 84).map(plain)).toEqual([
      "estimates from local logs, upper bounds, never quota",
      "reading local session logs…",
    ]);
  });
});

describe("the live session quota panel inside the terminal's rows where flags decide what stays", () => {
  const live = (width: number, rows: number) => sessionPanelWithin(Option.some(fixtureSessionView()), width, rows, Number.POSITIVE_INFINITY);

  test("overflows 24 rows at 40 columns when every session is shown", () => {
    expect(sessionPanelLines(Option.some(fixtureSessionView()), 40).length).toBeGreaterThan(24);
  });

  for (const [width, rows] of [[40, 24], [84, 24], [84, 12], [30, 8]] as const) {
    test(`fits ${width} by ${rows} and keeps all four flags in view`, () => {
      const lines = live(width, rows).map(plain);
      expect(lines.length).toBeLessThanOrEqual(rows);
      expect(lines.filter((row) => row.startsWith("⚑"))).toHaveLength(4);
    });
  }

  for (const [width, rows] of [[30, 8], [60, 6]] as const) {
    test(`keeps five flags, one five-hour plus three week plus one month, one row each with its window, at ${width} by ${rows}`, () => {
      const lines = sessionPanelWithin(Option.some(fiveHourAheadSessionView()), width, rows, Number.POSITIVE_INFINITY).map(plain);
      const flags = lines.filter((row) => row.startsWith("⚑"));
      expect(flags).toEqual([
        expect.stringMatching(/w1A:p2 5h claude main/u),
        expect.stringMatching(/w1A:p2 7d claude main/u),
        expect.stringMatching(/w2B:p2 7d claude main/u),
        expect.stringMatching(/pid 4242 7d claude main/u),
        expect.stringMatching(/w2B:p2 31d opencode-go/u),
      ]);
    });
  }

  const sevenFlags = (): SessionQuotaView => {
    const view = fiveHourAheadSessionView();
    return {
      ...view,
      accounts: view.accounts.flatMap((account) => {
        if (account.title !== "claude main" || account.body.kind !== "windows") return [];
        const found = account.body.windows.find((window) => window.id === "seven_day");
        if (found === undefined) return [];
        const week = { ...found, sessions: found.sessions.map((row) => ({ ...row, flagged: row.session.id === "pane:w1A:p2" })) };
        const windows = [1, 2, 3, 4, 5, 6, 7].map((hours) => ({ ...week, id: `w${hours}`, cycleSeconds: hours * 3600 }));
        return [{ ...account, body: { kind: "windows" as const, windows } }];
      }),
    };
  };

  test("shows five of seven flags in a 30 by 8 terminal with its two-row caption and counts the other two, naming the JSON command", async () => {
    const lines = sessionPanelWithin(Option.some(sevenFlags()), 30, 8, Number.POSITIVE_INFINITY);
    const setup = await createTestRenderer({ width: 30, height: 8 });
    setup.renderer.root.add(new TextRenderable(setup.renderer, { content: blockDocument(lines), wrapMode: "none" }));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    await setup.dispose();
    expect(frame.split("\n").map((row) => row.trimEnd()).filter((row) => row !== "")).toEqual([
      "estimates from local logs",
      "upper bounds, never quota",
      "⚑ sho…/1 w1A:p2 1h claude main",
      "⚑ sho…/1 w1A:p2 2h claude main",
      "⚑ sho…/1 w1A:p2 3h claude main",
      "⚑ sho…/1 w1A:p2 4h claude main",
      "⚑ sho…/1 w1A:p2 5h claude main",
      "+2 bun run session-quota-json",
    ]);
  });

  test("counts the hidden flags in words where the row has room", () => {
    expect(sessionPanelWithin(Option.some(sevenFlags()), 60, 5, Number.POSITIVE_INFINITY).map(plain).at(-1)).toBe(
      "+4 more flags, see bun run session-quota-json",
    );
  });

  test("keeps the two-line flags when they fit, and gives the note's rows up to them", () => {
    expect(flagLines({ ...fixtureSessionView(), unmatched: noted().unmatched }, 60, 10).map(plain)).toEqual([
      "estimates from local logs, upper bounds, never quota",
      "⚑ shop-a1b2c3/1 w1A:p2 · claude main 7d window",
      "  30.8pp/h, fair 0.15",
      "⚑ ~/my-home w2B:p2 · claude main 7d window",
      "  2.38pp/h, fair 0.15",
      "⚑ no-mistakes 0RUN42 pid 4242 · claude main 7d window",
      "  4.89pp/h, fair 0.15",
      "⚑ ~/my-home w2B:p2 · opencode-go 31d window",
      "  6.06pp/h, fair 0.13",
      "+2 more rows",
    ]);
  });

  test("keeps all four flags at 30 by 8 when a note competes for the rows", () => {
    const lines = sessionPanelWithin(Option.some(noted()), 30, 8, Number.POSITIVE_INFINITY).map(plain);
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(lines.filter((row) => row.startsWith("⚑"))).toHaveLength(4);
  });

  test("shows every session when the terminal has the rows", () => {
    expect(live(40, 100)).toEqual(sessionPanelLines(Option.some(fixtureSessionView()), 40));
  });
});
