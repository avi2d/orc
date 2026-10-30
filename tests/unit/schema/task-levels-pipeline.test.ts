import { describe, expect, test } from "bun:test";
import {
  decodeNoMistakes,
  decodeOrcShow,
  decodeTasksReport,
  ok,
  taskLevels,
  type TaskSampleRecord,
  unreachable,
} from "@tui-dash/schema";
import { valueOf } from "../../lib/outcomes";
import { fixture } from "../../lib/fixtures";
import { at, gib, taskReadings } from "../../lib/task-levels-fixture";

const projectNamed = (levels: ReturnType<typeof taskLevels>, name: string) => {
  const project = levels.projects.find((row) => row.name === name);
  if (project === undefined) throw new Error(`no project ${name}`);
  return project;
};

const taskNamed = (levels: ReturnType<typeof taskLevels>, project: string, id: string) => {
  const task = projectNamed(levels, project).tasks.find((row) => row.id === id);
  if (task === undefined) throw new Error(`no task ${id}`);
  return task;
};

describe("taskLevels joins each task to its recorded pipeline", () => {
  const fullSample: TaskSampleRecord = {
    schemaVersion: 1,
    at: at("2026-10-19T08:00:00Z"),
    machine: { cores: 16, memoryBytes: gib },
    task: {
      id: "tasks-pipe-full",
      title: "Fast-start review",
      project: "harbor",
      state: "working",
      firstStartedAt: at("2026-10-19T06:00:00Z"),
      endedAt: null,
    },
    usage: null,
    spend: null,
    tests: [],
  };

  const pipelineLevels = (overrides: Parameters<typeof taskReadings>[0] = {}) =>
    taskLevels(
      taskReadings({
        tasks: decodeTasksReport(fixture("tasks/pipeline.json")),
        samples: [fullSample],
        live: undefined,
        pueue: undefined,
        noMistakes: ok(valueOf(decodeNoMistakes(fixture("no-mistakes/run.txt")))),
        orc: ok(valueOf(decodeOrcShow(fixture("orc/show.json")))),
        ...overrides,
      }),
    );

  test("a full review fix joins the recorded run on its branch and keeps the report's state", () => {
    const task = taskNamed(pipelineLevels(), "harbor", "tasks-pipe-full");
    expect(task.kind).toBe("full review fix");
    expect(task.state).toBe("working");
    expect(task.lastActiveAt).toEqual(at("2026-10-19T08:00:00Z"));
    const marks = new Map(task.pipeline?.stages.map((stage) => [stage.name, stage.mark]));
    expect(marks.get("catch up with main")).toBe("done");
    expect(marks.get("CI")).toBe("done");
    expect(marks.get("merge")).toBe("next");
    expect(task.pipeline?.stages.find((stage) => stage.name === "review")?.detail).toBe("reviewer Sol · 7 awaiting, 1 auto-fix");
  });

  test("the report's check count lands on the stage its detail names", () => {
    const stages = taskNamed(pipelineLevels(), "harbor", "tasks-pipe-full").pipeline?.stages ?? [];
    expect(stages.find((stage) => stage.name === "CI")?.detail).toBe("6 of 9 passed");
    expect(stages.filter((stage) => stage.detail?.includes("6 of 9") === true).map((stage) => stage.name)).toEqual(["CI"]);
  });

  test("without its recorded run a full review fix dims its row instead of losing it", () => {
    const task = taskNamed(pipelineLevels({ noMistakes: undefined }), "harbor", "tasks-pipe-full");
    expect(task.pipeline?.kind).toBe("full review fix");
    expect(task.pipeline?.stages).toHaveLength(11);
    expect(task.pipeline?.stages.every((stage) => stage.mark === "unknown")).toBe(true);
  });

  test("a quick fix, a scout and a finished local task read their own detail lines", () => {
    const quick = taskNamed(pipelineLevels(), "harbor", "tasks-pipe-quick");
    expect(quick.pipeline?.stages.map((stage) => [stage.name, stage.mark])).toContainEqual(["CI", "active"]);
    const scout = taskNamed(pipelineLevels(), "harbor", "tasks-pipe-scout");
    expect(scout.pipeline?.stages.find((stage) => stage.name === "your calls")?.mark).toBe("needsYou");
    const local = taskNamed(pipelineLevels(), "harbor", "tasks-pipe-local");
    expect(local.pipeline?.stages.every((stage) => stage.mark === "done")).toBe(true);
  });

  test("an orc task joins the orc run on its branch, and a kind outside the five keeps no pipeline", () => {
    const run = taskNamed(pipelineLevels(), "harbor", "orc-step-7");
    expect(run.pipeline?.stages.find((stage) => stage.name === "agent")?.mark).toBe("active");
    expect(taskNamed(pipelineLevels(), "harbor", "tasks-pipe-build").pipeline).toBeUndefined();
  });

  test("a failed recorded step blocks a working task", () => {
    const recorded = valueOf(decodeNoMistakes(fixture("no-mistakes/run.txt")));
    const failing = recorded.map((run) => ({ ...run, status: "failed", steps: run.steps.map((step) => (step.step === "ci" ? { ...step, status: "failed" } : step)) }));
    const levels = pipelineLevels({ noMistakes: ok(failing) });
    expect(taskNamed(levels, "harbor", "tasks-pipe-full").state).toBe("blocked");
    expect(levels.projects.find((project) => project.name === "harbor")?.blocked).toBe(1);
  });

  test("a review awaiting you makes the task waiting, and a parked step parks it", () => {
    const recorded = valueOf(decodeNoMistakes(fixture("no-mistakes/run.txt")));
    const withReview = (status: string) => ok(recorded.map((run) => ({ ...run, status: "running", steps: run.steps.map((step) => (step.step === "review" ? { ...step, status } : step)) })));
    expect(taskNamed(pipelineLevels({ noMistakes: withReview("awaiting_approval") }), "harbor", "tasks-pipe-full").state).toBe("waiting");
    const parked = pipelineLevels({ noMistakes: withReview("parked") });
    expect(taskNamed(parked, "harbor", "tasks-pipe-full").state).toBe("parked");
    expect(projectNamed(parked, "harbor").parked).toBe(1);
    const reported = valueOf(decodeTasksReport(fixture("tasks/pipeline.json")));
    const waiting = ok({
      ...reported,
      view: { ...reported.view, tasks: reported.view.tasks.map((task) => (task.id === "tasks-pipe-full" && task.state !== "done" ? { ...task, state: "waiting" as const } : task)) },
    });
    expect(taskNamed(pipelineLevels({ tasks: waiting, noMistakes: withReview("parked") }), "harbor", "tasks-pipe-full").state).toBe("waiting");
  });

  test("a quick fix keeps the time since its detail first named its stage, not the time since the first sample or the last detail change", () => {
    const quickAt = (iso: string, detail: string | undefined): TaskSampleRecord => ({
      ...fullSample,
      at: at(iso),
      task: { ...fullSample.task, id: "tasks-pipe-quick", title: "Runner fault fix", ...(detail === undefined ? {} : { detail }) },
    });
    const anchorSeconds = (samples: ReadonlyArray<TaskSampleRecord>) =>
      taskNamed(pipelineLevels({ samples }), "harbor", "tasks-pipe-quick").pipeline?.stages.find((stage) => stage.name === "CI")?.seconds;
    const opened = quickAt("2026-10-19T07:40:00Z", "PR opened, waiting on checks to start");
    const first = quickAt("2026-10-19T07:50:00Z", "CI · 1 of 5 checks passed");
    const later = quickAt("2026-10-19T07:55:00Z", "CI · 3 of 5 checks passed · running 3m");
    expect(anchorSeconds([opened, first, later])).toBeCloseTo(731, 6);
    expect(anchorSeconds([quickAt("2026-10-19T07:50:00Z", undefined)])).toBeUndefined();
  });

  test("an orc run keeps the time since its observed stage began, not restarting when the wording changes", () => {
    const orcAt = (iso: string, detail: string | undefined, orcStage: string | undefined): TaskSampleRecord => ({
      ...fullSample,
      at: at(iso),
      task: { ...fullSample.task, id: "orc-step-7", title: "Step seven run", ...(detail === undefined ? {} : { detail }) },
      ...(orcStage === undefined ? {} : { orcStage }),
    });
    const anchorSeconds = (samples: ReadonlyArray<TaskSampleRecord>) =>
      taskNamed(pipelineLevels({ samples }), "harbor", "orc-step-7").pipeline?.stages.find((stage) => stage.name === "agent")?.seconds;
    const copying = orcAt("2026-10-19T07:45:00Z", "copying the task into its isolated copy", "isolated copy");
    const preparing = orcAt("2026-10-19T07:50:00Z", "preparing the isolated copy", "agent");
    const writing = orcAt("2026-10-19T07:55:00Z", "writing the run report command", "agent");
    expect(anchorSeconds([copying, preparing, writing])).toBeCloseTo(731, 6);
    expect(anchorSeconds([orcAt("2026-10-19T07:50:00Z", "writing the run report command", undefined)])).toBeUndefined();
  });

  test("an orc run restarts its time when the observed stage changes", () => {
    const orcAt = (iso: string, orcStage: string | undefined): TaskSampleRecord => ({
      ...fullSample,
      at: at(iso),
      task: { ...fullSample.task, id: "orc-step-7", title: "Step seven run", detail: "writing the run report command" },
      ...(orcStage === undefined ? {} : { orcStage }),
    });
    const advanced = valueOf(decodeOrcShow(fixture("orc/show.json"))).runs.map((run) => {
      if (run.branch !== "fm/orc-step-7") return run;
      return {
        ...run,
        stages: [
          ...run.stages.map((stage) => (stage.name === "implement" ? { ...stage, status: "completed" } : stage)),
          { name: "checks", status: "running", detail: undefined },
        ],
      };
    });
    const seconds = (samples: ReadonlyArray<TaskSampleRecord>) =>
      taskNamed(pipelineLevels({ samples, orc: ok({ runs: advanced }) }), "harbor", "orc-step-7").pipeline?.stages.find(
        (stage) => stage.name === "checks",
      )?.seconds;
    expect(seconds([orcAt("2026-10-19T07:50:00Z", "agent"), orcAt("2026-10-19T07:58:00Z", "checks")])).toBeCloseTo(251, 6);
  });

  test("an orc run keeps its full observed stage age after the first line leaves the window", () => {
    const aged = (iso: string): TaskSampleRecord => ({
      ...fullSample,
      at: at(iso),
      task: { ...fullSample.task, id: "orc-step-7", title: "Step seven run", detail: "writing the run report command" },
      orcStage: "agent",
      orcStageSince: at("2026-10-11T08:00:00Z"),
    });
    const lines = [aged("2026-10-11T08:00:00Z"), aged("2026-10-15T08:00:00Z"), aged("2026-10-19T08:00:00Z")];
    const seconds = (samples: ReadonlyArray<TaskSampleRecord>) =>
      taskNamed(pipelineLevels({ samples }), "harbor", "orc-step-7").pipeline?.stages.find((stage) => stage.name === "agent")?.seconds;
    expect(seconds(lines)).toBeCloseTo(691331, 6);
    expect(seconds(lines.slice(1))).toBeCloseTo(691331, 6);
  });

  test("the last activity is the last sample that did work, not the last sample", () => {
    const working = { ...fullSample, at: at("2026-10-19T07:50:00Z"), usage: { processes: [{ identity: "4100 07:00", ownSeconds: 60 }], cpuCores: 0.5, residentBytes: gib } };
    const idle = { ...fullSample, usage: { processes: [{ identity: "4100 07:00", ownSeconds: 60 }], cpuCores: 0, residentBytes: gib } };
    const task = taskNamed(pipelineLevels({ samples: [working, idle] }), "harbor", "tasks-pipe-full");
    expect(task.lastActiveAt).toEqual(at("2026-10-19T07:50:00Z"));
  });

  test("a pipeline source that fails is named, and the tasks still read", () => {
    const levels = pipelineLevels({ orc: unreachable("orc show gave no answer within 15 seconds") });
    expect(levels.failures).toEqual([{ source: "orc", failure: { kind: "unreachable", reason: "orc show gave no answer within 15 seconds" } }]);
    expect(taskNamed(levels, "harbor", "tasks-pipe-quick").pipeline?.kind).toBe("quick fix");
  });
});
