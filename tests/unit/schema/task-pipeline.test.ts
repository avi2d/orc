import { describe, expect, test } from "bun:test";
import {
  anchorOf,
  checksOf,
  cueMarkOf,
  cuePipelineOf,
  detailWithoutWaitsOf,
  decodeNoMistakes,
  decodeOrcRuns,
  decodeOrcShow,
  fixRoundOf,
  fullReviewPipelineOf,
  gateHoldOf,
  kindOf,
  longStageOf,
  markGlyphOf,
  modelBadgeOf,
  noMistakesRunOf,
  ok,
  orcPipelineOf,
  orcRunOf,
  pipelineFoldersOf,
  readableTestNameOf,
  stageNamesOf,
  stalenessOf,
  summaryOf,
  taskLevels,
  waitsOnOf,
  decodeTasksReport,
} from "@tui-dash/schema";
import { markToneOf } from "@tui-dash/tasks";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";
import { taskReadings } from "../../lib/task-levels-fixture";

describe("every kind of work keeps its own stage row, a quick fix without review stages and no invented row", () => {
  test("a full review fix runs the eleven recorded steps", () => {
    expect(stageNamesOf("full review fix")).toEqual([
      "build",
      "intent",
      "catch up with main",
      "review",
      "test",
      "docs",
      "lint",
      "push",
      "PR",
      "CI",
      "merge",
    ]);
  });

  test("a quick fix runs build, PR, CI and merge, with no review step", () => {
    const stages = stageNamesOf("quick fix");
    expect(stages).toEqual(["build", "PR", "CI", "merge"]);
    expect(stages).not.toContain("review");
    expect(stages).not.toContain("test");
  });

  test("local only, scout and orc runs each keep their own row", () => {
    expect(stageNamesOf("local only")).toEqual(["build", "ready branch", "your approval", "land locally"]);
    expect(stageNamesOf("scout")).toEqual(["investigate", "report", "your calls", "follow-ups filed"]);
    expect(stageNamesOf("orc run")).toEqual(["take task", "isolated copy", "agent", "checks", "fix, up to 3", "no-mistakes PR", "report"]);
  });

  test("a kind outside the five has no row rather than a borrowed one", () => {
    expect(kindOf("build")).toBeUndefined();
    expect(kindOf("Full Review Fix")).toBeUndefined();
    expect(kindOf("full review fix")).toBe("full review fix");
  });
});

describe("every stage mark keeps its own glyph and tone, a needs-you stage not in the waiting tone and an unread stage not drawn as next", () => {
  test("marks read as the legend draws them", () => {
    expect([markGlyphOf("done"), markToneOf("done")]).toEqual(["✓", "success"]);
    expect([markGlyphOf("active"), markToneOf("active")]).toEqual(["●", "primary"]);
    expect([markGlyphOf("needsYou"), markToneOf("needsYou")]).toEqual(["◆", "accent"]);
    expect([markGlyphOf("waiting"), markToneOf("waiting")]).toEqual(["◷", "warning"]);
    expect([markGlyphOf("failed"), markToneOf("failed")]).toEqual(["✕", "error"]);
    expect([markGlyphOf("next"), markToneOf("next")]).toEqual(["○", "muted"]);
    expect([markGlyphOf("skipped"), markToneOf("skipped")]).toEqual(["–", "muted"]);
  });

  test("an unread stage dims past next", () => {
    expect(markToneOf("unknown")).not.toBe(markToneOf("next"));
    expect(markToneOf("needsYou")).not.toBe(markToneOf("waiting"));
  });
});

describe("a full review fix reads its recorded pipeline steps, a merge not done from a passed pipeline alone", () => {
  const run = valueOf(decodeNoMistakes(fixture("no-mistakes/run.txt"))).find((entry) => entry.id === "01M5CFR1F0AA7A1FF8AM4DYM9V");

  test("the recorded run keeps its reviewer, findings, outcome and PR", () => {
    expect(run).toMatchObject({
      branch: "fm/tui-dash-fast-start",
      status: "completed",
      pr: "https://github.com/avi2d/tui-dash/pull/39",
      outcome: "passed",
      findings: "7 awaiting, 1 auto-fix",
      reviewer: "pi/openai/gpt-6.1-sol",
    });
    expect(run?.steps.map((step) => step.step)).toEqual(["intent", "rebase", "review", "test", "document", "lint", "push", "pr", "ci"]);
  });

  test("the recorded steps land on their canonical stages, with the review time kept", () => {
    const pipeline = fullReviewPipelineOf(run, "working");
    const marks = new Map(pipeline.stages.map((stage) => [stage.name, stage.mark]));
    expect(pipeline.kind).toBe("full review fix");
    expect(marks.get("build")).toBe("done");
    expect(marks.get("intent")).toBe("done");
    expect(marks.get("catch up with main")).toBe("done");
    expect(marks.get("review")).toBe("done");
    expect(marks.get("test")).toBe("done");
    expect(marks.get("docs")).toBe("done");
    expect(marks.get("lint")).toBe("done");
    expect(marks.get("push")).toBe("done");
    expect(marks.get("PR")).toBe("done");
    expect(marks.get("CI")).toBe("done");
    expect(pipeline.stages.find((stage) => stage.name === "review")?.seconds).toBeCloseTo(4501, 0);
  });

  test("a passed pipeline still leaves the merge for you, and names its reviewer short beside the review's findings", () => {
    const pipeline = fullReviewPipelineOf(run, "working");
    expect(pipeline.stages.find((stage) => stage.name === "merge")?.mark).toBe("next");
    expect(pipeline.stages.find((stage) => stage.name === "review")?.detail).toBe("reviewer Sol · 7 awaiting, 1 auto-fix");
    expect(pipeline.stages.find((stage) => stage.name === "test")?.detail).toBeUndefined();
  });

  test("a run nobody recorded leaves an unread row", () => {
    expect(fullReviewPipelineOf(undefined, "working").stages.every((stage) => stage.mark === "unknown")).toBe(true);
  });

  test("an overview row without step rows dims its row instead of guessing stages, and a completed run validates nothing", () => {
    if (run === undefined) throw new Error("no recorded run");
    const pipeline = fullReviewPipelineOf({ ...run, steps: [] }, "working");
    expect(pipeline.stages.every((stage) => stage.mark === "unknown")).toBe(true);
    expect(pipeline.validating).toBe(false);
  });

  test("a completed run skips a middle stage its steps never name", () => {
    if (run === undefined) throw new Error("no recorded run");
    const pipeline = fullReviewPipelineOf({ ...run, steps: run.steps.filter((step) => step.step !== "document") }, "working");
    expect(pipeline.stages.find((stage) => stage.name === "docs")?.mark).toBe("skipped");
    expect(pipeline.stages.find((stage) => stage.name === "test")?.mark).toBe("done");
  });

  test("a failed step stops its stage and finishes what came before", () => {
    const failed =
      run === undefined
        ? undefined
        : { ...run, steps: run.steps.filter((step) => step.step !== "test" && step.step !== "document" && step.step !== "lint" && step.step !== "push" && step.step !== "pr" && step.step !== "ci").concat([{ step: "test", status: "failed", findings: 2, durationMs: 1000, active: undefined }]) };
    const stages = fullReviewPipelineOf(failed, "working").stages;
    const marks = new Map(stages.map((stage) => [stage.name, stage.mark]));
    expect(marks.get("test")).toBe("failed");
    expect(stages.find((stage) => stage.name === "test")?.detail).toBe("2 findings");
    expect(marks.get("review")).toBe("done");
    expect(marks.get("docs")).toBe("unknown");
  });
});

describe("a full review fix reads every status no-mistakes prints", () => {
  const fixing = valueOf(decodeNoMistakes(fixture("no-mistakes/run-fixing.txt"))).find((entry) => entry.id === "01M5CXGP3C0WRHQ6XN7NAX7HQ5");
  if (fixing === undefined) throw new Error("no recorded run");
  const withReview = (status: string) => ({ ...fixing, steps: fixing.steps.map((step) => (step.step === "review" ? { ...step, status } : step)) });
  const markOf = (status: string) => fullReviewPipelineOf(withReview(status), "working").stages.find((stage) => stage.name === "review")?.mark;

  test("a fixing review works now, its earlier steps done and its later ones next", () => {
    const pipeline = fullReviewPipelineOf(fixing, "working");
    expect(pipeline.stages.map((stage) => stage.mark)).toEqual(["done", "done", "done", "active", "next", "next", "next", "next", "next", "next", "unknown"]);
    expect(anchorOf(pipeline.stages)?.name).toBe("review");
    expect(pipeline.validating).toBe(true);
  });

  test("the open review keeps its time so far and its fix round from the active row", () => {
    expect(fixing.steps.find((step) => step.step === "review")?.active).toEqual({ seconds: 498, round: "fix 1" });
    expect(fixing.steps.find((step) => step.step === "test")?.active).toBeUndefined();
    const review = fullReviewPipelineOf(fixing, "working").stages.find((stage) => stage.name === "review");
    expect(review?.seconds).toBe(498);
    expect(review?.detail).toBe("reviewer Opus · 6 awaiting, 6 auto-fix · fix 1 of 2");
  });

  test("awaiting approval needs you, parked waits on something else, and cancelled stops", () => {
    expect(markOf("awaiting_approval")).toBe("needsYou");
    expect(anchorOf(fullReviewPipelineOf(withReview("awaiting_approval"), "working").stages)?.name).toBe("review");
    expect(markOf("parked")).toBe("waiting");
    expect(markOf("cancelled")).toBe("failed");
  });

  test("a blocked worker turns its open stage red while the validation keeps running", () => {
    const pipeline = fullReviewPipelineOf(fixing, "blocked");
    expect(pipeline.stages.find((stage) => stage.name === "review")?.mark).toBe("failed");
    expect(pipeline.stages.filter((stage) => stage.mark === "failed")).toHaveLength(1);
    expect(pipeline.validating).toBe(true);
  });
});

describe("a recorded gate hold carries its parked time", () => {
  const fixing = valueOf(decodeNoMistakes(fixture("no-mistakes/run-fixing.txt"))).find((entry) => entry.id === "01M5CXGP3C0WRHQ6XN7NAX7HQ5");
  if (fixing === undefined) throw new Error("no recorded run");
  const gated = (status: string, parkedSeconds: number | undefined = 8100, state: "working" | "blocked" = "working") =>
    fullReviewPipelineOf({ ...fixing, parkedSeconds, steps: fixing.steps.map((step) => (step.step === "review" ? { ...step, status } : step)) }, state);

  test("the parked clock decodes from the pipeline's own scalar", () => {
    const parked = valueOf(decodeNoMistakes(`run:\n  id: "r1"\n  branch: fm/x\n  status: running\n  awaiting_agent: parked 2h15m\n  head: abc\n`));
    expect(parked[0]?.parkedSeconds).toBe(8100);
    const missing = valueOf(decodeNoMistakes(`run:\n  id: "r2"\n  branch: fm/x\n  status: running\n  head: abc\n`));
    expect(missing[0]?.parkedSeconds).toBeUndefined();
  });

  test("an open review without a gate status holds nothing", () => {
    expect(gateHoldOf(gated("fixing"))).toBeUndefined();
  });

  test("a review awaiting you holds a needs-you gate for the parked clock", () => {
    expect(gateHoldOf(gated("awaiting_approval", 7500))).toEqual({ mark: "needsYou", seconds: 7500 });
  });

  test("a parked review holds a waiting gate for the parked clock", () => {
    expect(gateHoldOf(gated("parked", 8100))).toEqual({ mark: "waiting", seconds: 8100 });
  });

  test("a stopped worker's gate reads as stopped, not held", () => {
    expect(gateHoldOf(gated("awaiting_approval", 7500, "blocked"))).toBeUndefined();
  });

  test("a cue row built from worker detail holds no gate even when it waits", () => {
    expect(gateHoldOf(cuePipelineOf("scout", "waiting", "needs a decision on 3 review findings", []))).toBeUndefined();
    expect(gateHoldOf(cuePipelineOf("quick fix", "parked", "drive call running in background", []))).toBeUndefined();
  });

  test("a finished run and an unread row hold no gate", () => {
    const done = valueOf(decodeNoMistakes(fixture("no-mistakes/run.txt"))).find((entry) => entry.id === "01M5CFR1F0AA7A1FF8AM4DYM9V");
    if (done === undefined) throw new Error("no recorded run");
    expect(gateHoldOf(fullReviewPipelineOf(done, "working"))).toBeUndefined();
    expect(gateHoldOf(fullReviewPipelineOf(undefined, "working"))).toBeUndefined();
    expect(gateHoldOf(undefined)).toBeUndefined();
  });
});

describe("the recorded overview joins each run to its branch, and no run invented from an unreadable line", () => {
  const snapshot = valueOf(decodeNoMistakes(fixture("no-mistakes/overview.txt")));

  test("the overview keeps every run with its branch, status and PR", () => {
    expect(snapshot).toHaveLength(8);
    expect(snapshot.find((run) => run.id === "01M5CRTKB9KS7MPBNCZA1EFWFH")).toMatchObject({
      branch: "fm/tui-dash-projects-hide-done",
      status: "failed",
      pr: "",
    });
  });

  test("a task meets the run on its own branch and no other", () => {
    expect(noMistakesRunOf(snapshot, ["fm/tui-dash-fast-start"])?.id).toBe("01M5CFR1F0AA7A1FF8AM4DYM9V");
    expect(noMistakesRunOf(snapshot, ["fm/never-recorded"])).toBeUndefined();
  });

  test("an unreadable line reads as no runs rather than invented ones", () => {
    expect(valueOf(decodeNoMistakes("nothing the tool printed\n"))).toEqual([]);
  });
});

describe("the other kinds read their own status record, no rebuild stage invented and a plain wait not needs-you", () => {
  test("a scout with no cue works its first stage", () => {
    const pipeline = cuePipelineOf("scout", "working", "Reading the access logs", []);
    expect(pipeline.stages.map((stage) => stage.mark)).toEqual(["active", "next", "next", "next"]);
  });

  test("a decision you owe turns the named stage to needs-you", () => {
    const pipeline = cuePipelineOf("scout", "waiting", "needs a decision on 3 review findings · waiting 4m", []);
    const anchor = pipeline.stages.find((stage) => stage.mark === "needsYou");
    expect(anchor?.name).toBe("your calls");
  });

  test("the task state alone names the open stage's mark", () => {
    expect(cueMarkOf("waiting")).toBe("needsYou");
    expect(cueMarkOf("parked")).toBe("waiting");
    expect(cueMarkOf("blocked")).toBe("failed");
    expect(cueMarkOf("working")).toBe("active");
    expect(cuePipelineOf("scout", "waiting", "3 findings to triage", []).stages.map((stage) => stage.mark)).toEqual(["needsYou", "next", "next", "next"]);
    expect(cuePipelineOf("local only", "parked", "waiting on your approval slot", []).stages.find((stage) => stage.name === "your approval")?.mark).toBe(
      "waiting",
    );
  });

  test("a quick fix mid-CI keeps its past stages done and its merge next", () => {
    const pipeline = cuePipelineOf("quick fix", "working", "CI · 3 of 5 checks passed · running 3m", []);
    expect(pipeline.stages.map((stage) => [stage.name, stage.mark])).toEqual([
      ["build", "done"],
      ["PR", "done"],
      ["CI", "active"],
      ["merge", "next"],
    ]);
  });

  test("the rebuild stage joins only when the record mentions it", () => {
    expect(cuePipelineOf("quick fix", "working", "reproducing the runner fault", []).stages.map((stage) => stage.name)).toEqual([
      "build",
      "PR",
      "CI",
      "merge",
    ]);
    expect(
      cuePipelineOf("quick fix", "waiting", "waiting on your rebuild of the Mac config", []).stages.map((stage) => [stage.name, stage.mark]),
    ).toContainEqual(["your rebuild", "needsYou"]);
  });

  test("a failure the record names stops its stage", () => {
    const pipeline = cuePipelineOf("quick fix", "blocked", "CI failed: e2e · 1 of 2 checks red", []);
    expect(pipeline.stages.find((stage) => stage.name === "CI")?.mark).toBe("failed");
    expect(anchorOf(pipeline.stages)?.name).toBe("CI");
  });

  test("an unread task dims its row", () => {
    expect(cuePipelineOf("local only", "unknown", "", []).stages.every((stage) => stage.mark === "unknown")).toBe(true);
  });

  test("the stage a detail is on wins over a later one it mentions, a passed test count is not CI", () => {
    expect(cuePipelineOf("quick fix", "working", "tests passed, opening PR", []).stages.map((stage) => [stage.name, stage.mark])).toEqual([
      ["build", "done"],
      ["PR", "active"],
      ["CI", "next"],
      ["merge", "next"],
    ]);
    expect(anchorOf(cuePipelineOf("scout", "working", "investigating; will report back", []).stages)?.name).toBe("investigate");
  });

  test("a detail names only the stage it is about", () => {
    expect(anchorOf(cuePipelineOf("quick fix", "working", "CI · 3 of 5 checks passed · running 3m", []).stages)?.detail).toBe("3 of 5 passed");
    expect(anchorOf(cuePipelineOf("scout", "working", "Reading 4 decided findings in the logs", []).stages)?.detail).toBeUndefined();
  });
});

describe("a stage line names what the record says, no invented waits-on", () => {
  test("findings, awaits, auto-fixes, rounds, checks and waits-on read off the detail", () => {
    expect(summaryOf("test · fixing 4 decided findings · fix 2 · round running 3m")).toBe("4 findings · fix 2 of 2");
    expect(summaryOf("review · 7 awaiting, 1 auto-fix")).toBe("7 awaiting · 1 auto-fix");
    expect(summaryOf("CI · 3 of 5 checks passed · running 3m")).toBe("3 of 5 passed");
    expect(summaryOf("waiting for the checks kit release with the quick-tests split · 2h 46m")).toBe(
      "waits on the checks kit release with the quick-tests split",
    );
  });

  test("a fix round past 2 is no round, and a record with no waits names none", () => {
    expect(fixRoundOf("fix 3")).toBeUndefined();
    expect(fixRoundOf("fix 2")).toBe(2);
    expect(fixRoundOf("prefix 2 files")).toBeUndefined();
    expect(checksOf("no counts here")).toBeUndefined();
    expect(checksOf("fixing, 0 of 3 so far")).toBeUndefined();
    expect(summaryOf("fixing, 0 of 3 so far")).toBeUndefined();
    expect(waitsOnOf("reproducing the runner fault")).toBeUndefined();
  });

  test("taking the cue out keeps the rest of the detail", () => {
    expect(detailWithoutWaitsOf("waiting on owner approval")).toBeUndefined();
    expect(detailWithoutWaitsOf("waiting on owner approval \u00B7 3 findings need a decision")).toBe("3 findings need a decision");
    expect(detailWithoutWaitsOf("reproducing the runner fault")).toBe("reproducing the runner fault");
    expect(detailWithoutWaitsOf("3 findings \u00B7 waiting on owner approval")).toBe("3 findings");
    expect(detailWithoutWaitsOf("3 findings \u00B7 waiting on owner approval \u00B7 2h 46m")).toBe("3 findings \u00B7 2h 46m");
  });
});

describe("a quiet stage changes colour, a fresh stage not stale and a long idle stage not merely busy", () => {
  test("five idle minutes turn a stage yellow and fifteen turn it red", () => {
    expect(stalenessOf(0, 4 * 60 * 1000)).toBe("fresh");
    expect(stalenessOf(0, 5 * 60 * 1000)).toBe("yellow");
    expect(stalenessOf(0, 15 * 60 * 1000)).toBe("red");
    expect(stalenessOf(undefined, 15 * 60 * 1000)).toBe("none");
  });

  test("two busy hours in one stage turn it yellow too", () => {
    expect(longStageOf(2 * 60 * 60, true)).toBe(true);
    expect(longStageOf(2 * 60 * 60 - 1, true)).toBe(false);
    expect(longStageOf(3 * 60 * 60, false)).toBe(false);
  });
});

describe("badges name the machine, the model and the kind, no model badge the sessions never recorded", () => {
  test("Opus, Sonnet, Haiku and Muse read off the session model, and anything else keeps its name", () => {
    expect(modelBadgeOf("claude-opus-5-5")).toBe("Opus");
    expect(modelBadgeOf("muse-spark-preview-0423")).toBe("Muse");
    expect(modelBadgeOf("claude-sonnet-4-6")).not.toBe("Muse");
    expect(modelBadgeOf("claude-sonnet-5-5")).toBe("Sonnet");
    expect(modelBadgeOf("claude-haiku-5-5")).toBe("Haiku");
    expect(modelBadgeOf("claude-haiku-4-5-20251001")).toBe("Haiku");
    expect(modelBadgeOf(undefined)).toBeUndefined();
    expect(modelBadgeOf("gpt-5")).toBe("gpt-5");
  });

});

describe("test runs get readable names, with no leading cd, no redirection kept as a word, and no cat or rm named as the test run", () => {
  test("a chained line names the checks it runs and leaves out folders, flags, pipes and redirections", () => {
    expect(readableTestNameOf("cd /Users/example/.no-mistakes/worktrees/a7c0a0c20df7/01M5CFR1F0AA7A1FF8AM4DYM9V/ && bun test tests/unit/dashboard/banded 2>&1 | tail -20")).toBe(
      "bun test banded",
    );
    expect(readableTestNameOf("bun run lint 2>&1 | tail -4; echo LINT:$?; bun run test 2>&1 | tail -30")).toBe("bun run lint · bun run test");
    expect(readableTestNameOf("bun test --help 2>&1 | grep -i timeout")).toBe("bun test");
    expect(readableTestNameOf("rm tests/unit/scaffold.test.ts; bun run test 2>&1 | tail -40; bun run typecheck 2>&1 | tail -10")).toBe(
      "bun run test · bun run typecheck",
    );
    expect(readableTestNameOf("cat tsconfig.json | head -30; bun run lint 2>&1 | tail -5")).toBe("bun run lint");
  });

  test("a flag value names the flag rather than the run", () => {
    expect(readableTestNameOf("bun test --timeout 5000 tests/unit/dashboard/banded")).toBe("bun test banded");
    expect(readableTestNameOf("bun test --grep foo tests/unit/dashboard/banded")).toBe("bun test banded");
    expect(readableTestNameOf("bun --watch test")).toBe("bun test");
  });

  test("a single command keeps its program and words, and a line with no check keeps its first command", () => {
    expect(readableTestNameOf("/opt/homebrew/bin/bun test --watch ./harbor")).toBe("bun test harbor");
    expect(readableTestNameOf("sleep 800 > /dev/null")).toBe("sleep 800");
  });
});

describe("an orc run reads orc show, a listing never read as a run", () => {
  const snapshot = valueOf(decodeOrcShow(fixture("orc/show.json")));

  test("the recorded run keeps its branch and its steps", () => {
    expect(snapshot.runs.map((run) => run.id)).toEqual(["20261024-091523-7f3a9c"]);
    expect(orcRunOf(snapshot, "no-such-run", ["fm/orc-step-7"])?.stages).toEqual([
      { name: "implement", status: "running", detail: undefined },
    ]);
    expect(orcRunOf(snapshot, "no-such-run", ["fm/someone-else"])).toBeUndefined();
  });

  test("the running run shows its copy taken and its agent working", () => {
    const pipeline = orcPipelineOf(orcRunOf(snapshot, "20261024-091523-7f3a9c", []), "working");
    const marks = new Map(pipeline.stages.map((stage) => [stage.name, stage.mark]));
    expect([marks.get("take task"), marks.get("isolated copy"), marks.get("agent")]).toEqual(["done", "done", "active"]);
    expect(marks.get("report")).toBe("unknown");
    expect(anchorOf(pipeline.stages)?.name).toBe("agent");
  });

  test("the scored step keeps its score note, and a status orc never named dims", () => {
    const stale = valueOf(decodeOrcShow(fixture("orc/show-stale.json")));
    expect(orcRunOf(stale, "20261023-141007-2b8e51", [])?.stages.find((stage) => stage.name === "implement")?.detail).toBe(
      "clean slice",
    );
    const weird = valueOf(
      decodeOrcShow(
        JSON.stringify({
          schema: "orc.show.v1",
          run: { id: "weird", branch: "fm/weird" },
          steps: [{ name: "implement", status: "weird-status", score: null }],
        }),
      ),
    );
    const pipeline = orcPipelineOf(orcRunOf(weird, "weird", []), "working");
    expect(pipeline.stages.find((stage) => stage.name === "agent")?.mark).toBe("unknown");
    expect(pipeline.stages.find((stage) => stage.name === "report")?.mark).toBe("unknown");
  });

  test("the fix capture maps the fix step to the fix stage", () => {
    const captured = valueOf(decodeOrcShow(fixture("orc/show-fix.json")));
    expect(orcRunOf(captured, "20261024-110247-9c1d07", [])?.stages.find((stage) => stage.name === "fix")?.status).toBe("running");
    const pipeline = orcPipelineOf(orcRunOf(captured, "20261024-110247-9c1d07", []), "working");
    const marks = new Map(pipeline.stages.map((stage) => [stage.name, stage.mark]));
    expect([marks.get("take task"), marks.get("isolated copy"), marks.get("agent")]).toEqual(["done", "done", "done"]);
    expect(marks.get("fix, up to 3")).toBe("active");
    expect(marks.get("checks")).toBe("next");
    expect(anchorOf(pipeline.stages)?.name).toBe("fix, up to 3");
    expect(pipeline.stages.find((stage) => stage.name === "agent")?.detail).toBe("slice landed with a failing check");
    expect(marks.get("report")).toBe("unknown");
    const tasks = fixture("tasks/pipeline.json").replace("fm/orc-step-7", "fm/orc-fix-loop");
    const row = taskLevels(
      taskReadings({
        tasks: decodeTasksReport(tasks),
        samples: [],
        live: undefined,
        pueue: undefined,
        noMistakes: undefined,
        orc: ok(captured),
      }),
    ).projects.flatMap((project) => project.tasks).find((task) => task.id === "orc-step-7");
    expect(row?.pipeline?.stages.find((stage) => stage.name === "checks")?.mark).toBe("next");
    expect(row?.state).toBe("working");
  });

  test("the no-mistakes capture maps the no-mistakes step to the no-mistakes PR stage", () => {
    const captured = valueOf(decodeOrcShow(fixture("orc/show-nomistakes.json")));
    expect(orcRunOf(captured, "20261024-115512-4e7b22", [])?.stages.find((stage) => stage.name === "no-mistakes")?.status).toBe("running");
    const pipeline = orcPipelineOf(orcRunOf(captured, "20261024-115512-4e7b22", []), "working");
    const marks = new Map(pipeline.stages.map((stage) => [stage.name, stage.mark]));
    expect([marks.get("agent"), marks.get("checks")]).toEqual(["done", "done"]);
    expect(marks.get("no-mistakes PR")).toBe("active");
    expect(marks.get("report")).toBe("unknown");
  });

  test("a listing is not a run, and a run is not a listing", () => {
    expect(decodeOrcShow(fixture("orc/runs.json")).kind).toBe("invalid");
    expect(decodeOrcRuns(fixture("orc/show.json")).kind).toBe("invalid");
  });

  test("output outside JSON reads as unread, never as an empty run", () => {
    expect(decodeOrcShow("not json").kind).toBe("invalid");
    expect(decodeOrcShow("{}").kind).toBe("invalid");
    expect(decodeOrcRuns("not json").kind).toBe("invalid");
    expect(decodeOrcRuns("{}").kind).toBe("invalid");
  });
});

describe("the current stage is the one the line talks about", () => {
  test("failed outranks needs-you, which outranks waiting, which outranks working", () => {
    const stages = cuePipelineOf("scout", "waiting", "needs a decision on 3 review findings", []).stages;
    expect(anchorOf(stages)?.name).toBe("your calls");
    expect(anchorOf(cuePipelineOf("scout", "waiting", "waiting on your calls", []).stages)?.name).toBe("your calls");
    expect(anchorOf(cuePipelineOf("quick fix", "working", "reproducing the runner fault", []).stages)?.name).toBe("build");
  });
});

describe("only open tasks of a recorded kind ask for a read", () => {
  const tasks = valueOf(decodeTasksReport(fixture("tasks/pipeline.json"))).view.tasks;

  test("each folder asks once with every branch its open tasks work on", () => {
    expect(pipelineFoldersOf(tasks, "full review fix")).toEqual([{ folder: "/home/example/work/harbor", branches: ["fm/tui-dash-fast-start"] }]);
    expect(pipelineFoldersOf(tasks, "orc run").map((wanted) => wanted.folder)).toEqual(["/home/example/work/harbor"]);
    expect(pipelineFoldersOf(tasks.filter((task) => task.kind !== "full review fix"), "full review fix")).toEqual([]);
  });

  test("a finished task asks for nothing", () => {
    const finished = tasks.map((task) => (task.kind === "full review fix" ? { ...task, state: "done" as const, endedAt: task.startedAt } : task));
    expect(pipelineFoldersOf(finished, "full review fix")).toEqual([]);
  });
});
