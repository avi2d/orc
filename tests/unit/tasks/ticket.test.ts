import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { cuePipelineOf, decodeNoMistakes, donePipelineOf, fullReviewPipelineOf, modelBadgeOf, stageNamesOf, taskLevels, taskSpend } from "@tui-dash/schema";
import { effortOf, pillLines, ticketLines, tintOfModel } from "@tui-dash/tasks";
import { plain, type Tone } from "@tui-dash/ui";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";
import type { TaskRow } from "@tui-dash/schema";
import { call, fifthIn, hour, six, viewOf } from "../../lib/quota-view-fixture";
import { pipelineTaskReadings } from "../../lib/task-levels-fixture";

const utc = DateTime.zoneMakeNamedUnsafe("UTC");

const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso);

const base: TaskRow = {
  id: "harbor-ticket-full",
  machine: "north",
  source: "local",
  listed: true,
  usageRead: false,
  title: "Fast-start review",
  project: "harbor",
  state: "working",
  detail: "reviewing the run",
  firstStartedAt: at("2026-10-19T06:00:00Z"),
  endedAt: undefined,
  seconds: 8040,
  cpuSeconds: 2460,
  peakBytes: undefined,
  live: undefined,
  idled: false,
  tests: [],
  testSeconds: undefined,
  episodes: [],
  spend: { model: "claude-opus-4-5", tokens: 48000, outputTokens: 9000, fair: undefined, provider: undefined },
  kind: "full review fix",
  pipeline: cuePipelineOf("quick fix", "working", "building", []),
  lastActiveAt: at("2026-10-19T08:00:00Z"),
};

const textOf = (row: TaskRow, width = 60): string =>
  ticketLines(row, { machine: "north", source: "local", listed: true, usageRead: false }, at("2026-10-19T08:02:11Z"), utc, width).map(plain).join("\n");

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

describe("the ticket effort mark", () => {
  test("letters follow the prototype token bands", () => {
    expect(effortOf(7999)).toBe("S");
    expect(effortOf(8000)).toBe("M");
    expect(effortOf(29_999)).toBe("M");
    expect(effortOf(30_000)).toBe("L");
    expect(effortOf(4000)).toBe("S");
    expect(effortOf(9000)).toBe("M");
    expect(effortOf(14000)).toBe("M");
    expect(effortOf(21000)).toBe("M");
    expect(effortOf(48000)).toBe("L");
    expect(effortOf(112000)).toBe("L");
    expect(effortOf(undefined)).toBeUndefined();
  });

  test("a session reading half a million cached tokens for 3k of output reads S", () => {
    const [session] = six;
    const cached = { ...call(session, fifthIn - 10 * 60_000, 0), tokens: { input: 2000, output: 3000, cacheRead: 480_000, cacheWrite: 20_000 } };
    const view = viewOf({ now: fifthIn, weekStatus: "on_pace", weekLeft: 60 }, [session], [cached]);
    const owner = { id: "alpha", folders: ["/work/a"], firstStartedAt: DateTime.makeUnsafe(fifthIn - 24 * hour), endedAt: null };
    const spend = taskSpend(view, [owner], () => true).get("alpha");
    expect(spend?.outputTokens).toBe(3000);
    expect(textOf({ ...base, spend })).toContain("\u25CF Opus S 505k tok");
  });
});

const dotToneOf = (row: TaskRow): Tone | undefined =>
  ticketLines(row, { machine: "north", source: "local", listed: true, usageRead: false }, at("2026-10-19T08:02:11Z"), utc, 60)
    .flat()
    .find((part) => part.text === "\u25CF ")?.style.tone;

describe("the ticket model tint", () => {
  test("opus reads claude, codex reads codex, opencode reads opencodeGo", () => {
    expect(tintOfModel("claude-opus-4-5")).toBe("claude");
    expect(tintOfModel("codex-mini")).toBe("codex");
    expect(tintOfModel("opencode-rex")).toBe("opencodeGo");
    expect(tintOfModel(undefined)).toBe("muted");
  });

  test("the dot takes its billing account's tint, else its model's", () => {
    const [session] = six;
    const muse = { ...call(session, fifthIn - 2 * hour, 3000), quota: "opencode-go" as const, model: "muse-spark-1.3-contributor" };
    const view = viewOf({ now: fifthIn, weekStatus: "on_pace", weekLeft: 60 }, [session], [muse]);
    const owner = { id: "alpha", folders: ["/work/a"], firstStartedAt: DateTime.makeUnsafe(fifthIn - 24 * hour), endedAt: null };
    const billed = taskSpend(view, [owner], () => true).get("alpha");
    expect(billed).toMatchObject({ provider: "opencode-go" });
    if (billed === undefined) throw new Error("alpha has no spend");
    expect(dotToneOf({ ...base, spend: billed })).toBe("opencodeGo");
    expect(dotToneOf({ ...base, spend: { ...billed, provider: undefined } })).toBe("claude");
  });
});

describe("the ticket facts", () => {
  test("kind lives in the header, the model lives in the model line, the lane lives in the grey line", () => {
    const text = textOf(base);
    expect(text).toContain("harbor-ticket-full");
    expect(text).toContain("quick fix");
    expect(countOf(text, "quick fix")).toBe(1);
    expect(countOf(text, modelBadgeOf(base.spend?.model) ?? "Opus")).toBe(1);
    expect(countOf(text, "north")).toBe(1);
  });

  test("words form carries start and duration", () => {
    const working = textOf(base);
    expect(working).toMatch(/started .* \u00B7 running for .* \u00B7 north/u);
    const done = textOf({ ...base, state: "done", endedAt: at("2026-10-19T07:30:00Z"), pipeline: donePipelineOf("quick fix") });
    expect(done).toMatch(/started .* \u00B7 ended .* \u00B7 ran .* \u00B7 north/u);
    expect(working).not.toContain("\u2192");
  });

  test("waiting names what it waits on", () => {
    const waiting = textOf({ ...base, state: "waiting", detail: "waiting on owner approval" });
    expect(waiting).toContain("waiting on owner approval");
  });
});

describe("the ticket stage pills", () => {
  test("every stage name shows once with its mark", () => {
    const names = stageNamesOf("quick fix");
    const lines = pillLines(cuePipelineOf("quick fix", "working", "CI \u00B7 3 of 5 passed", []), 200).map(plain).join("\n");
    for (const name of names) expect(countOf(lines, name)).toBe(1);
    expect(lines).toContain("\u2713");
    expect(lines).toContain("\u25CF");
  });

  test("a finished run keeps its pills above its done line", () => {
    const done = textOf({ ...base, state: "done", endedAt: at("2026-10-19T07:30:00Z"), pipeline: donePipelineOf("quick fix") });
    for (const name of stageNamesOf("quick fix")) expect(countOf(done, `[\u2713 ${name}]`)).toBe(1);
  });

  test("a blocked worker keeps the validation still running notice", () => {
    const blocked = textOf({
      ...base,
      state: "blocked",
      pipeline: {
        kind: "full review fix",
        stages: [{ name: "review", mark: "failed", detail: "lint broke", seconds: undefined }],
        validating: true,
        parkedSeconds: undefined,
      },
    });
    expect(blocked).toContain("review \u00B7 validation still running \u00B7 lint broke");
  });
});

describe("the ticket stage line", () => {
  const fixtureRow = (id: string): TaskRow => {
    const row = taskLevels(pipelineTaskReadings()).projects.flatMap((project) => project.tasks).find((task) => task.id === id);
    if (row === undefined) throw new Error(`no task ${id}`);
    return row;
  };

  test("leaves the total to the grey line", () => {
    const text = textOf(base);
    expect(countOf(text, "2h 14m")).toBe(1);
    expect(text).toContain("running for 2h 14m");
  });

  test("leaves out the detail the description already gives", () => {
    const quick = textOf(fixtureRow("tasks-pipe-quick"));
    expect(countOf(quick, "3 of 5")).toBe(1);
    expect(quick.split("\n")).toContain("CI");
    const baseRow = fixtureRow("orc-step-7");
    const repeated = baseRow.pipeline === undefined ? baseRow : { ...baseRow, pipeline: { ...baseRow.pipeline, stages: baseRow.pipeline.stages.map((stage) => (stage.name === "agent" ? { ...stage, detail: baseRow.detail } : stage)) } };
    const orc = textOf(repeated);
    expect(countOf(orc, "writing the run report command")).toBe(1);
    expect(orc.split("\n")).toContain("agent");
  });
});

describe("a description cut at two lines", () => {
  test("leaves the stage line what the cut hid", () => {
    const detail = "Moving the bridge queue onto the new runner and rewriting its retry policy for the pool \u00B7 6 of 9 checks passed \u00B7 waiting on owner approval";
    const parked = textOf({ ...base, state: "parked", kind: "quick fix", detail, pipeline: cuePipelineOf("quick fix", "parked", detail, []) }, 56);
    expect(parked).toContain("passed");
    expect(parked).toContain("owner approval");
  });
});

describe("a header too narrow for its kind", () => {
  test("shows the whole id without a dangling separator", () => {
    for (const id of ["harbor-ticket-full-quick", "harbor-ticket-full-qui"]) {
      expect(textOf({ ...base, id, kind: "quick fix" }, 26).split("\n")[0]).toBe(id);
    }
  });
});

describe("a ticket parked at a review gate", () => {
  const gated = (reviewStatus: string, seconds: number | undefined): TaskRow => {
    const run = valueOf(decodeNoMistakes(fixture("no-mistakes/run.txt"))).find((entry) => entry.id === "01M5CFR1F0AA7A1FF8AM4DYM9V");
    if (run === undefined) throw new Error("no recorded run");
    const parked = {
      ...run,
      status: "running",
      parkedSeconds: seconds,
      steps: run.steps.map((step) => (step.step === "review" ? { ...step, status: reviewStatus, active: { seconds: 498, round: "fix 1" } } : step)),
    };
    return {
      ...base,
      state: reviewStatus === "parked" ? "parked" : "waiting",
      detail: "drive call running in background",
      pipeline: fullReviewPipelineOf(parked, "working"),
    };
  };

  test("the pipeline test-names gate reads waiting for a decision with its parked time", () => {
    const text = textOf(gated("awaiting_approval", 7500));
    expect(text).toContain("\u25C6 waiting for a decision");
    expect(text).toContain("waiting for 2h 5m");
    expect(text).not.toContain("drive call running in background");
    expect(text).not.toContain("waiting for 2h 14m");
    expect(text).not.toContain("waiting for 8m");
  });

  test("the chat-questions gate reads waiting for a decision with its parked time", () => {
    const text = textOf(gated("parked", 8100));
    expect(text).toContain("\u25F7 waiting for a decision");
    expect(text).toContain("parked for 2h 15m");
    expect(text).not.toContain("drive call running in background");
    expect(text).not.toContain("parked for 2h 14m");
    expect(text).not.toContain("parked for 8m");
  });

  test("a gate without a parked clock shows no parked time rather than the task run time", () => {
    const text = textOf(gated("awaiting_approval", undefined));
    expect(text).toContain("\u25C6 waiting for a decision");
    expect(text).not.toContain("waiting for 2h 14m");
  });
});

describe("the ticket kept facts", () => {
  test("the description and the kept cpu and peak show once", () => {
    const text = textOf(base);
    expect(countOf(text, "reviewing the run")).toBe(1);
    expect(countOf(text, "kept   cpu")).toBe(1);
    expect(countOf(text, "peak memory")).toBe(1);
  });

  test("a waiting cue stays on the status line while the rest of the detail stays as the description", () => {
    const waiting = textOf({ ...base, state: "waiting", detail: "waiting on owner approval \u00B7 3 findings need a decision" });
    expect(countOf(waiting, "waiting on owner approval")).toBe(1);
    expect(countOf(waiting, "3 findings need a decision")).toBe(1);
  });

  test("a parked task keeps what it awaits in its description", () => {
    const parked = textOf({ ...base, state: "parked", pipeline: undefined, detail: "waiting for the checks kit release with the quick-tests split \u00B7 2h 46m" });
    expect(parked).toContain("parked");
    expect(parked).toContain("checks kit release");
    expect(parked).toContain("quick-tests");
    expect(parked).toContain("split \u00B7 2h 46m");
  });

  test("a long wait wraps the status instead of truncating it", () => {
    const waiting = textOf({ ...base, state: "waiting", detail: "waiting for the checks kit release with the quick-tests split \u00B7 2h 46m" }, 40);
    expect(waiting).toContain("waiting on the checks kit release with");
    expect(waiting).toContain("the quick-tests split");
    expect(waiting).toContain("2h 46m");
  });

  test("a narrow box wraps the fair share with its flag instead of cutting it", () => {
    const spend = { model: "claude-opus-5-5", tokens: 2_100_000, outputTokens: 41_000, fair: { account: "Claude main", cycleSeconds: 604_800, ratio: 4.6, flagged: true }, provider: undefined };
    for (const width of [40, 44]) {
      const flagged = textOf({ ...base, spend }, width);
      expect(flagged).toContain("4.6\u00D7 fair \u2691");
      expect(countOf(flagged, "\u2691")).toBe(1);
    }
  });

  test("a finished task's fair-share flag draws as past in its ticket", () => {
    const fair = { account: "Claude main", cycleSeconds: 604_800, ratio: 4.6, flagged: true };
    const flagged = { model: "claude-opus-4-5", tokens: 2_100_000, outputTokens: 41_000, fair , provider: undefined };
    const origin = { machine: "north", source: "local", listed: true, usageRead: false } as const;
    const fairPart = (row: TaskRow) =>
      ticketLines(row, origin, at("2026-10-19T08:02:11Z"), utc, 60).flat().find((part) => part.text.includes("\u00D7 fair"));
    expect(fairPart({ ...base, spend: flagged })?.style).toMatchObject({ tone: "error", bold: true });
    const done = fairPart({ ...base, state: "done", endedAt: at("2026-10-19T07:30:00Z"), pipeline: donePipelineOf("quick fix"), spend: flagged });
    expect(done?.style.tone).toBe("foreground");
    expect(done?.style.bold ?? false).toBe(false);
  });

  test("an oversized fair share compacts to its ratio and flag", () => {
    const compact = textOf({
      ...base,
      spend: { model: "claude-opus-5-5", tokens: 2_100_000, outputTokens: 41_000, fair: { account: "Claude main", cycleSeconds: 604_800, ratio: 4.6, flagged: true }, provider: undefined },
    }, 26);
    expect(compact).toContain("4.6\u00D7 fair \u2691");
    expect(countOf(compact, "\u2691")).toBe(1);
  });
});
