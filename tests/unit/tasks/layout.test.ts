import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import {
  decodeNoMistakes,
  decodeTasksReport,
  ok,
  type TaskLevels,
  taskLevels,
  type TaskRow,
  type TaskSpend,
} from "@tui-dash/schema";
import { drawTasks, type Navigation, type TasksReadings, ticketLines } from "@tui-dash/tasks";
import { type Line, lineWidth, plain } from "@tui-dash/ui";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";
import { at, gib, harborCrowdedToday, live, notesEndedToday, pipelineTaskReadings, southTaskReadings, taskReadings, tasksNow, withSpend } from "../../lib/task-levels-fixture";

const utc = DateTime.zoneMakeNamedUnsafe("UTC");

const readings = (overrides: Parameters<typeof taskReadings>[0] = {}): TasksReadings => ({
  levels: taskLevels(taskReadings(overrides)),
  zone: utc,
});

const onProjects: Navigation = { focus: "projects", project: undefined, task: undefined, detail: 0 };

const onHarbor: Navigation = { focus: "tasks", project: "harbor", task: undefined, detail: 0 };

const onBridge: Navigation = { focus: "task", project: "harbor", task: "north tasks-bridge-plot", detail: 0 };

const drawn = (navigation: Navigation, columns = 120, rows = 20, value = readings()) => drawTasks(value, navigation, columns, rows);

const texts = (navigation: Navigation, columns = 120, rows = 20, value = readings()): ReadonlyArray<string> => drawn(navigation, columns, rows, value).block.map(plain);

const titles = (lines: ReadonlyArray<string>): ReadonlyArray<string> => [...(lines[1] ?? "").matchAll(/[╭┏][─━] (.+?) [─━]/gu)].map((match) => match[1]);

const rowNamed = (navigation: Navigation, name: string, columns = 120): Line => {
  const found = drawn(navigation, columns).block.slice(3).find((line) => plain(line).includes(` ${name} `));
  if (found === undefined) throw new Error(`no row ${name}`);
  return found;
};

const backgroundAt = (line: Line, column: number): string | undefined => {
  let end = 0;
  for (const part of line) {
    end += part.text.length;
    if (column < end) return part.style.background;
  }
  return undefined;
};

describe("the levels on screen", () => {
  test("shows every level from 240 columns, two under 240 and one under 120, ending at the focus", () => {
    expect(titles(texts(onBridge, 119))).toEqual(["tasks-bridge-plot"]);
    expect(titles(texts(onBridge, 120))).toEqual(["harbor · tasks", "tasks-bridge-plot"]);
    expect(titles(texts(onBridge, 239))).toEqual(["harbor · tasks", "tasks-bridge-plot"]);
    expect(titles(texts(onBridge, 240))).toEqual(["projects · today", "harbor · tasks", "tasks-bridge-plot"]);
    expect(titles(texts(onProjects, 120))).toEqual(["projects · today", "harbor · tasks"]);
  });

  test("every line is as wide as the screen and the frame fills its rows", () => {
    for (const columns of [40, 84, 120, 181]) {
      const lines = drawn(onHarbor, columns, 24).block;
      expect(lines).toHaveLength(24);
      expect(lines.map(lineWidth)).toEqual(lines.map(() => columns));
    }
  });

  test("every box is 60 columns, and the columns left over stay blank", () => {
    for (const columns of [84, 200]) {
      const top = texts(onBridge, columns)[1] ?? "";
      const corners = [...top.matchAll(/[╮┓]/gu)].map((match) => match.index + 1);
      expect(corners).toEqual(columns === 84 ? [60] : [60, 120]);
      expect(top.slice(corners.at(-1))).toBe(" ".repeat(columns - (corners.at(-1) ?? 0)));
    }
    expect(texts(onBridge, 40)[1]).toMatch(/^┏━ tasks-bridge-plot ━+┓$/u);
  });

  test("draws the focused level in a heavy frame and the others light", () => {
    const top = texts(onHarbor)[1] ?? "";
    expect(top.startsWith("╭─ projects")).toBe(false);
    expect(top).toMatch(/^┏━ harbor · tasks ━+┓╭─ tasks-bridge-plot ─+╮$/u);
  });

  test("highlights the pick in the focused level brightly, a held pick dimly, and none to the right of the focus", () => {
    expect(backgroundAt(rowNamed(onProjects, "harbor", 120), 4)).toBe("pick");
    expect(backgroundAt(rowNamed(onProjects, "harbor", 120), 64)).toBeUndefined();
    expect(backgroundAt(rowNamed(onHarbor, "tasks-bridge-plot", 240), 4)).toBe("held");
    expect(backgroundAt(rowNamed(onHarbor, "tasks-bridge-plot", 240), 64)).toBe("pick");
    expect(backgroundAt(rowNamed(onHarbor, "tasks-inbox-sweep", 240), 64)).toBeUndefined();
  });

  test("the top line is the path to the focus and the bottom line lists the keys", () => {
    const lines = texts(onBridge);
    expect(lines[0]).toMatch(/^ projects › harbor › tasks-bridge-plot +08:02 $/u);
    expect(lines.at(-1)?.trimEnd()).toBe(" ↑↓ pick   ⏎/→ in   esc/← back   click to open   q quit");
    expect(texts(onBridge, 240).at(-1)?.trimEnd()).toBe(
      " ↑↓ pick a row   ⏎ or → step in   esc or ← step back   click a row to open it   click a name in the top line to jump there   q quit",
    );
  });

  test("each name in the top line jumps to its level and each row opens the level to its right", () => {
    const { targets } = drawn(onBridge, 120);
    const targetAt = (row: number, column: number) => targets.find((target) => target.row === row && target.from <= column && column < target.to)?.state;
    expect(targetAt(0, 4)).toEqual({ focus: "projects", project: "harbor", task: "north tasks-bridge-plot", detail: 0 });
    expect(targetAt(0, 14)).toEqual({ focus: "tasks", project: "harbor", task: "north tasks-bridge-plot", detail: 0 });
    expect(targetAt(0, 0)).toBeUndefined();
    expect(targetAt(0, 10)).toBeUndefined();
    expect(targetAt(4, 10)).toEqual({ focus: "task", project: "harbor", task: "north tasks-inbox-sweep", detail: 0 });
    expect(targetAt(4, 70)).toBeUndefined();
  });

  test("a cut frame keeps no click target on its summary row", () => {
    const single: TasksReadings = { levels: taskLevels(southTaskReadings()), zone: utc };
    const short = drawTasks(single, onProjects, 84, 3);
    const summary = short.block.findIndex((line) => /^\+\d+ more rows/.test(plain(line)));
    expect(summary).toBe(2);
    expect(short.targets.length).toBeGreaterThan(0);
    expect(short.targets.every((target) => target.row < summary)).toBe(true);
  });

  test("a list longer than its box keeps the pick in sight and counts the rows left out", () => {
    const value: TasksReadings = { levels: taskLevels(harborCrowdedToday()), zone: utc };
    const lines = texts({ focus: "tasks", project: "harbor", task: "north harbor-day-a", detail: 0 }, 84, 8, value);
    expect(lines.slice(2, 6).map((line) => line.slice(2, 22).trimEnd())).toEqual(["  task", "  harbor-day-b", "  harbor-day-a", "+4 more rows"]);
  });
});

const notesToday = (): TasksReadings => ({ levels: taskLevels(notesEndedToday()), zone: utc });

describe("the projects on screen", () => {
  const projectsHead = (value = readings()): string => (texts(onProjects, 120, 20, value)[2] ?? "").slice(0, 60);
  const projectsRows = (value = readings()): ReadonlyArray<string> => texts(onProjects, 120, 20, value).slice(3, 6).map((line) => line.slice(0, 80));

  test("counts each live state and the plan under a short plain header", () => {
    const value = notesToday();
    expect(projectsHead(value)).toMatch(/project +work +wait +park +block +done +plan/u);
    expect(projectsHead(value)).not.toMatch(/cpu|mem|time/u);
    expect(projectsRows(value)).toEqual([
      expect.stringMatching(/total +1 +1 +– +– +1 +–/u),
      expect.stringMatching(/harbor +1 +1 +– +– +– +–/u),
      expect.stringMatching(/notes +– +– +– +– +1 +–/u),
    ]);
  });

  test("paints the header plain, each count in its state's colour, and a quiet project dimmed", () => {
    const { block } = drawn(onProjects, 120, 20, notesToday());
    const head = (block.find((line) => plain(line).includes("work wait")) ?? []).slice(0, 3);
    expect(head.map((part) => part.style.tone)).toEqual(["focus", "subtle", "focus"]);

    const harbor = (block.find((line) => / harbor +1 /u.test(plain(line))) ?? []).slice(0, 10);
    expect(harbor.filter((part) => part.text.trim() === "1").map((part) => part.style.tone)).toEqual(["primary", "warning"]);
    const notes = (block.find((line) => / notes +–/u.test(plain(line))) ?? []).slice(2, 8);
    expect(notes.length).toBe(6);
    expect([...new Set(notes.map((part) => part.style.tone))]).toEqual(["muted"]);
  });

});

describe("one task", () => {
  test("says how it stands, what it is, what it kept, its live processes and its test runs", () => {
    const lines = texts(onBridge, 60, 20).map((line) => line.slice(2, -2).trimEnd());
    expect(lines.slice(2, 18)).toEqual([
      "tasks-bridge-plot · build",
      "Plot the bridge migration",
      "Moving the bridge queue to the new runner",
      "● working",
      "started Sun 22:15 · running for 9h 47m · north",
      "no model recorded",
      "kept   cpu 17m · peak memory 1.0G",
      "processes                                      cpu   mem",
      "▶ pi                                            9m  0.4G",
      "▶ node                                          1m  0.1G",
      "▶ git                                          <1m  0.0G",
      "▶ python3                                      <1m  0.0G",
      "▶ cat                                          <1m  0.0G",
      "test runs                                 took     ended",
      "✓ pueue bun test                            1m     07:56",
      "✗ pueue bun run lint                       20s     05:00",
    ]);
  });

  test("names each test run readably", () => {
    const recorded = taskReadings().pueue;
    if (recorded?.kind !== "ok") throw new Error("no recorded pueue");
    const command = "cat tsconfig.json | head -30; bun run lint 2>&1 | tail -5";
    const pueue = ok({ ...recorded.value, tasks: { ...recorded.value.tasks, "1": { ...recorded.value.tasks["1"], command } } });
    const lines = texts(onBridge, 60, 20, { levels: taskLevels(taskReadings({ pueue })), zone: utc }).map((line) => line.slice(2, -2).trimEnd());
    expect(lines).toContain("✓ pueue bun run lint                        1m     07:56");
  });

  test("shows a kept peak of two digit gigabytes whole", () => {
    const levels = taskLevels(taskReadings());
    const projects = levels.projects.map((project) =>
      project.name === "harbor"
        ? { ...project, residentBytes: 14 * 1024 ** 3, tasks: project.tasks.map((task) => (task.id === "tasks-bridge-plot" ? { ...task, peakBytes: 14 * 1024 ** 3 } : task)) }
        : project,
    );
    const ticket = texts(onBridge, 60, 20, { levels: { ...levels, projects }, zone: utc }).map((line) => line.slice(2, -2).trimEnd());
    expect(ticket).toContain("kept   cpu 17m · peak memory 14.0G");
    const projectBox = texts(onProjects, 120, 20, { levels: { ...levels, projects }, zone: utc }).map((line) => line.slice(0, 60));
    expect(projectBox.some((line) => line.includes("14.0G"))).toBe(false);
  });

  test("flags a task over a quarter of memory now", () => {
    const tight = readings({ live: ok(live(2 * 1024 ** 3)) });
    const lines = texts(onBridge, 60, 20, tight).map((line) => line.slice(2, -2).trimEnd());
    expect(lines).toContain("⚑ holds over a quarter of memory now");
    expect(plain(drawTasks(tight, onHarbor, 84, 20).block[3] ?? [])).toContain("▶ ⚑ tasks-bridge-plot");
  });
});

describe("how a task stands", () => {
  const standing = (project: string, task: string, from: number, value = readings()) =>
    texts({ focus: "task", project, task, detail: 0 }, 60, 20, value)
      .slice(from, from + 2)
      .map((line) => line.slice(2, -2).trimEnd());

  test("a done task gives its start, its end and how long it ran", () => {
    expect(standing("notes", "north tasks-release-notes", 5, notesToday())).toEqual(["✓ done", "started 06:00 · ended 07:30 · ran 1h 30m · north"]);
  });

  test("a waiting task gives its start and how long it has waited, without calling it running", () => {
    expect(standing("harbor", "north tasks-inbox-sweep", 4)).toEqual([expect.stringMatching(/^◷ waiting/u), "started 06:00 · waiting for 2h 2m · north"]);
  });

  test("a task no longer listed still gives its start", () => {
    expect(standing("harbor", "north harbor-gone", 4)).toEqual(["○ no longer listed", expect.stringMatching(/^started 05:00 · last seen /u)]);
  });
});

describe("a standing line wider than its box", () => {
  test("wraps onto a second line rather than cutting how long the task ran", () => {
    const lines = texts({ focus: "task", project: "harbor", task: "north harbor-gone", detail: 0 }, 40, 20).map((line) => line.slice(2, -2).trimEnd());
    expect(lines.slice(5, 7)).toEqual(["started 05:00 · last seen 06:00", "ran 1h 0m · north"]);
  });
});

describe("one task on a short screen", () => {
  const listed = (detail: number, rows: number) =>
    texts({ ...onBridge, detail }, 60, rows)
      .map((line) => line.slice(2, -2).trimEnd())
      .slice(6, 10);

  test("cuts the ticket head on a short screen so the pick and the count still show", () => {
    expect(listed(0, 12)).toEqual(["started Sun 22:15 · running for 9h 47m · north", "no model recorded", "▶ pi                                            9m  0.4G", "+8 more rows"]);
    expect(listed(6, 12)).toEqual(["started Sun 22:15 · running for 9h 47m · north", "no model recorded", "✗ pueue bun run lint                       20s     05:00", "+8 more rows"]);
  });

  test("scrolls its processes and test runs to keep the pick and counts the rows it leaves out", () => {
    expect(listed(0, 16)).toEqual(["started Sun 22:15 · running for 9h 47m · north", "no model recorded", "kept   cpu 17m · peak memory 1.0G", "processes                                      cpu   mem"]);
    expect(listed(6, 16)).toEqual(["started Sun 22:15 · running for 9h 47m · north", "no model recorded", "kept   cpu 17m · peak memory 1.0G", "▶ cat                                          <1m  0.0G"]);
  });

  test("highlights the pick brightly, and a click on a process or test run picks it", () => {
    const { block, targets } = drawTasks(readings(), { ...onBridge, detail: 6 }, 60, 16);
    expect(backgroundAt(block[12] ?? [], 4)).toBe("pick");
    expect(backgroundAt(block[11] ?? [], 4)).toBeUndefined();
    expect(targets.find((target) => target.row === 11)?.state).toEqual({ ...onBridge, detail: 5 });
    expect(targets.find((target) => target.row === 10)).toBeUndefined();
  });
});

describe("the model on the row", () => {
  const spend: TaskSpend = {
    model: "claude-opus-5-5",
    tokens: 2_100_000,
    outputTokens: 41_000,
    fair: { account: "Claude main", cycleSeconds: 604_800, ratio: 0.3, flagged: false }, provider: undefined,
  };

  test("a task's row carries the short badge in its model column, with only its tokens under it", () => {
    const rows = texts(onHarbor, 60, 20, withSpend(spend)).map((line) => line.slice(2, -2).trimEnd());
    expect(rows.slice(3, 7)).toEqual([
      expect.stringMatching(/^▶ tasks-bridge-plot +working +Opus +1m +9h 47m$/u),
      "    2.1M tok",
      expect.stringMatching(/^▶ tasks-inbox-sweep +waiting +– +2m +2h 2m$/u),
      expect.stringMatching(/^  harbor-gone +unknown +– +– +1h 0m$/u),
    ]);
    const box = texts(onBridge, 60, 20, withSpend(spend)).map((line) => line.slice(2, -2).trimEnd());
    expect(box.slice(6, 8)).toEqual(["started Sun 22:15 · running for 9h 47m · north", "● Opus L 2.1M tok · 7d Claude main 0.3× fair"]);
  });

  test("a non-Claude model shows the ticket's full badge in the pane", () => {
    const kimi = withSpend({ ...spend, model: "kimi-k2.5", fair: undefined });
    const pane = texts(onHarbor, 84, 20, kimi).map((line) => line.slice(2, -2).trimEnd());
    const row = pane.find((line) => line.includes("tasks-bridge-plot")) ?? "";
    const ticket = texts(onBridge, 84, 20, kimi).map((line) => line.slice(2, -2).trimEnd());
    const badge = (ticket.find((line) => line.includes("kimi-k2.5"))?.match(/●\s+(\S+)/u) ?? [])[1];
    expect(badge).toBe("kimi-k2.5");
    expect(row).toContain(` ${badge} `);
    expect(row).not.toContain("…");
  });

  test("a narrow box wraps the model line instead of cutting its fair share", () => {
    const box = texts(onBridge, 40, 20, withSpend(spend)).map((line) => line.slice(2, -2).trimEnd());
    expect(box.slice(9, 11)).toEqual(["● Opus L 2.1M tok", "  7d Claude main 0.3× fair"]);
  });

  test("a task over its fair share is flagged on its row", () => {
    const over = withSpend({ ...spend, fair: { account: "Claude main", cycleSeconds: 604_800, ratio: 4.6, flagged: true } });
    expect((texts(onHarbor, 84, 20, over)[3] ?? "").slice(2, 23)).toBe("▶ ⚑ tasks-bridge-plot");
  });

  test("a burst the flag left quiet shows no flag and no multiple in the pane", () => {
    const burst = withSpend({ ...spend, fair: { account: "OpenCode Go", cycleSeconds: 2_678_400, ratio: 6.5, flagged: false } });
    const block = drawn(onHarbor, 84, 20, burst).block;
    expect(plain(block[3] ?? []).slice(2, 23).trimEnd()).toBe("▶ tasks-bridge-plot");
    expect(block.map((line) => plain(line)).join("\n")).not.toContain("× fair");
    const ticket = drawn(onBridge, 84, 20, burst).block.map(plain).join("\n");
    expect(ticket).toContain("31d OpenCode Go 6.5× fair");
    expect(ticket).not.toContain("⚑");
  });

  test("a flag stays in its own slot on a row with no live process", () => {
    const flagged: TaskSpend = { ...spend, fair: { account: "Claude main", cycleSeconds: 604_800, ratio: 4.6, flagged: true } };
    const bridge = withSpend(flagged);
    const both: TasksReadings = {
      ...bridge,
      levels: {
        ...bridge.levels,
        projects: bridge.levels.projects.map((project) => ({
          ...project,
          tasks: project.tasks.map((row) => (row.id === "harbor-gone" ? { ...row, spend: flagged } : row)),
        })),
      },
    };
    const marks = (name: string) => (texts(onHarbor, 84, 20, both).find((line) => line.includes(` ${name} `)) ?? "").slice(2, 6);
    expect([marks("tasks-bridge-plot"), marks("harbor-gone")]).toEqual(["▶ ⚑ ", "  ⚑ "]);
  });

  test("a task the report no longer lists draws its fair-share flag as past on its row", () => {
    const flagged: TaskSpend = { ...spend, fair: { account: "Claude main", cycleSeconds: 604_800, ratio: 4.6, flagged: true } };
    const bridge = withSpend(flagged);
    const projects = bridge.levels.projects.map((project) => ({ ...project, tasks: project.tasks.map((row) => (row.id === "harbor-gone" ? { ...row, spend: flagged } : row)) }));
    const block = drawn(onHarbor, 84, 20, { ...bridge, levels: { ...bridge.levels, projects } }).block;
    const mark = (name: string) => (block.find((line) => plain(line).includes(` ${name} `)) ?? []).find((part) => part.text === "\u2691 ");
    expect(mark("tasks-bridge-plot")?.style).toMatchObject({ tone: "error", bold: true });
    expect(mark("harbor-gone")?.style).toMatchObject({ tone: "warning" });
    expect(mark("harbor-gone")?.style.bold ?? false).toBe(false);
  });

  test("a flagged list keeps its columns lined up under the head", () => {
    const over = withSpend({ ...spend, fair: { account: "Claude main", cycleSeconds: 604_800, ratio: 4.6, flagged: true } });
    const lines = texts(onHarbor, 84, 20, over).map((line) => line.slice(2, -2));
    const stateAt = (lines[2] ?? "").indexOf("state");
    expect([lines[3] ?? "", lines[5] ?? ""].map((line) => line.slice(stateAt, stateAt + 7))).toEqual(["working", "waiting"]);
  });

  test("the pick's highlight runs to the box's inner edge on every line of the row, bright or held", () => {
    const bright = drawTasks(withSpend(spend), onHarbor, 60, 20).block;
    expect([3, 4].map((row) => backgroundAt(bright[row] ?? [], 57))).toEqual(["pick", "pick"]);
    const held = drawTasks(withSpend(spend), onBridge, 120, 20).block;
    expect([3, 4].map((row) => backgroundAt(held[row] ?? [], 57))).toEqual(["held", "held"]);
  });

  test("clicking the tokens line opens its task", () => {
    const { targets } = drawTasks(withSpend(spend), onHarbor, 84, 20);
    expect(targets.find((target) => target.row === 4)?.state).toEqual(onBridge);
  });
});

describe("a task's pipeline on screen", () => {
  const pipe = (overrides: Parameters<typeof pipelineTaskReadings>[0] = {}): TasksReadings => ({
    levels: taskLevels(pipelineTaskReadings(overrides)),
    zone: utc,
  });

  const row = (levels: TaskLevels, id: string) => {
    const task = levels.projects.flatMap((project) => project.tasks).find((entry) => entry.id === id);
    if (task === undefined) throw new Error(`no task ${id}`);
    return task;
  };

  const ticket = (task: TaskRow): ReadonlyArray<Line> => ticketLines(task, { machine: "north", source: "local", listed: true, usageRead: false }, tasksNow, utc, 60);

  const ticketText = (task: TaskRow): ReadonlyArray<string> => ticket(task).map(plain);

  test("a finished recorded run shows its marks and merge as the open stage, with no reading borrowed from another stage", () => {
    const lines = ticketText(row(pipe().levels, "tasks-pipe-full"));
    expect(lines.join(" ").match(/\[✓ /gu)).toHaveLength(10);
    expect(lines.join(" ")).toContain("[○ merge]");
    expect(lines).toContain("merge");
  });

  test("a stopped worker turns its stage red and notes the validation still running", () => {
    const reported = valueOf(decodeTasksReport(fixture("tasks/pipeline.json")));
    const stopped = ok({
      ...reported,
      view: {
        ...reported.view,
        tasks: reported.view.tasks.map((task) => (task.id === "tasks-pipe-full" && task.state !== "done" ? { ...task, state: "blocked" as const } : task)),
      },
    });
    const fixing = valueOf(decodeNoMistakes(fixture("no-mistakes/run-fixing.txt"))).map((run) => ({ ...run, branch: "fm/tui-dash-fast-start" }));
    const lines = ticket(row(pipe({ tasks: stopped, noMistakes: ok(fixing) }).levels, "tasks-pipe-full"));
    expect(lines.map(plain)).toContain("review · validation still running · reviewer Opus");
    expect(lines.map(plain)).toContain("6 awaiting, 6 auto-fix · fix 1 of 2");
    expect(lines.map(plain)).toContain("8m in review");
    expect(lines.flat().find((part) => part.text === "[✕ review]")?.style.tone).toBe("error");
  });

  test("a quick fix mid-CI and a scout waiting on a call show their open stage once beside the description", () => {
    const levels = pipe().levels;
    const quick = ticketText(row(levels, "tasks-pipe-quick"));
    expect(quick).toContain("[✓ build] [✓ PR] [● CI] [○ merge]");
    expect(quick).toContain("CI");
    const scout = ticketText(row(levels, "tasks-pipe-scout"));
    expect(scout.join(" ")).toContain("[✓ investigate] [✓ report] [◆ your calls] [○ follow-ups filed]");
    expect(scout).toContain("your calls");
  });

  test("without its recorded run the row dims instead of clearing, and a task outside the five shows nothing", () => {
    const unknown = ticketText(row(pipe({ noMistakes: undefined }).levels, "tasks-pipe-full"));
    expect(unknown).toContain("no pipeline recorded");
    expect(unknown.join(" ")).toContain("[○ merge]");
    const build = ticketText(row(pipe().levels, "tasks-pipe-build"));
    expect(build.some((line) => line.startsWith("["))).toBe(false);
    expect(build).not.toContain("no pipeline recorded");
  });

  test("a task unseen for minutes warns, and one unseen longer reads red", () => {
    const seen = (iso: string): TaskLevels =>
      pipe({
        samples: [
          {
            schemaVersion: 1,
            at: at(iso),
            machine: { cores: 16, memoryBytes: gib },
            task: {
              id: "tasks-pipe-quick",
              title: "Runner fault fix",
              project: "harbor",
              state: "working",
              firstStartedAt: DateTime.makeUnsafe("2026-10-19T07:30:00Z"),
              endedAt: null,
            },
            usage: null,
            spend: null,
            tests: [],
          },
        ],
      }).levels;
    const tones = (levels: TaskLevels) => ticket(row(levels, "tasks-pipe-quick")).find((line) => plain(line) === "CI")?.[0]?.style.tone;
    expect(tones(seen("2026-10-19T07:56:11Z"))).toBe("warning");
    expect(tones(seen("2026-10-19T07:40:11Z"))).toBe("error");
  });

  test("the tasks list carries each row's dots in their own tones", () => {
    const lines = texts({ focus: "tasks", project: "harbor", task: undefined, detail: 0 }, 120, 20, pipe());
    const dots = (id: string) => lines.find((line) => line.includes(id) && line.includes("working"));
    expect(dots("tasks-pipe-full")).toContain("✓✓✓✓✓✓✓✓✓✓○");
    expect(dots("orc-step-7")).toContain("✓✓●○○○○");
  });
});
