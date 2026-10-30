import { describe, expect, test } from "bun:test";
import { DateTime, Option } from "effect";
import { decodePueue, type LiveTasks, machinesView, ok, type QueueReadings, type ScheduleRead, type TaskListing, type TaskSampleRecord, taskLevels } from "@tui-dash/schema";
import { lineWidth, plain } from "@tui-dash/ui";
import { type BandedReadings, bandedReadings } from "../../lib/banded-fixture";
import { dashboardNow, recordedResources } from "../../lib/dashboard-fixture";
import { fixture } from "../../lib/fixtures";
import { bandedDrawn, bandedLines, bandedScreen, type Step } from "../../lib/host-fixture";
import { at, gib, live, southTaskReadings, taskReadings } from "../../lib/task-levels-fixture";

const texts = (columns: number, rows: number, steps: ReadonlyArray<Step> = []): ReadonlyArray<string> => bandedLines(columns, rows, steps);

interface Scheduled {
  readonly schedules?: ReadonlyArray<ScheduleRead>;
  readonly pueues: QueueReadings["machines"];
  readonly orchestrators: BandedReadings["listings"];
}

// The orchestrator's schedule rides in its task listing, so a listing without schedules is an orchestrator with nothing scheduled.
const unscheduled = (): TaskListing => {
  const listing = bandedReadings().listings.at(0)?.listing;
  return listing?.kind === "ok" ? ok({ ...listing.value, view: { ...listing.value.view, schedules: [] } }) : { kind: "unset" };
};

const emptyPueue = Option.some(decodePueue(JSON.stringify({ tasks: {}, groups: {} })));

const scheduledLines = ({ schedules, pueues, orchestrators }: Scheduled): ReadonlyArray<string> =>
  bandedLines(240, 60, [{ press: "s" }], {
    ...bandedReadings(),
    schedules: schedules === undefined ? Option.none() : Option.some(schedules),
    queues: { machines: pueues, actions: { repo: "example/shop", runs: Option.some(ok([])) } },
    listings: orchestrators,
  });

// Each box carries its title in its top edge, so the titles on an edge line name the boxes on that line.
const titlesOn = (line: string | undefined): ReadonlyArray<string> =>
  [...(line ?? "").matchAll(/╭─ (.*?) ─*╮/gu)].map((match) => (match.at(1) ?? "").replace(/\s*↻.*$/u, "").replace(/ ─+$/u, "").trimEnd());

const titleRows = (lines: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> => lines.map(titlesOn).filter((titles) => titles.length > 0);

describe("the banded dashboard", () => {
  for (const [columns, rows] of [[240, 60], [240, 36], [120, 40], [120, 36], [160, 48]] as const) {
    test(`fills a ${columns}x${rows} terminal exactly and keeps a row per alert rule`, () => {
      const lines = bandedDrawn(columns, rows).block;
      expect(lines).toHaveLength(rows);
      for (const line of lines) expect(lineWidth(line)).toBe(columns);
      expect(titleRows(lines.map(plain))).toContainEqual(["queue | scheduled"]);
      const alerts = bandedDrawn(columns, rows, [{ press: "a" }]).block;
      expect(alerts).toHaveLength(rows);
      for (const line of alerts) expect(lineWidth(line)).toBe(columns);
      const text = alerts.map(plain).join("\n");
      for (const rule of ["quota-pace", "heavy-load", "long-task", "nightly"]) expect(text).toContain(rule);
    });
  }

  test("puts the quota, the shared notices box and the ledger across the top of a 240 column screen", () => {
    const rows = titleRows(texts(240, 60));
    expect(rows[0]).toEqual(["quota", "gluttons | alerts", "ledger \u00b7 today"]);
    expect(rows).toContainEqual(["machines", "projects \u00b7 today", "harbor · tasks"]);
    expect(rows).toContainEqual(["queue | scheduled"]);
    expect(texts(240, 60).at(-1)).not.toMatch(/[┐┌‹›]/u);
    expect(texts(240, 60).some((line) => line.includes("│ 4 running · 1 waiting · 2 queued in pueue "))).toBe(true);
  });

  test("pins each pane's refresh cadence at the right end of its title", () => {
    for (const [columns, rows] of [[120, 40], [240, 60]] as const) {
      const lines = texts(columns, rows);
      const edges = lines.filter((line) => line.startsWith("╭─"));
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        const closers = edge.match(/─╮/gu) ?? [];
        const pinned = edge.match(/↻ \d+[smh] ─╮/gu) ?? [];
        expect(closers.length).toBeGreaterThan(0);
        expect(pinned.length).toBe(closers.length);
      }
    }
  });

  test("stacks the quota over the shared notices box on a 120 column screen and holds the ledger in the top right of a 120 column screen, beside the quota over the shared notices box", () => {
    const lines = texts(120, 40);
    const rows = titleRows(lines);
    expect(rows[0]).toEqual(["quota", "ledger \u00b7 today"]);
    expect(rows).toContainEqual(["gluttons | alerts"]);
    expect(rows).toContainEqual(["queue | scheduled"]);
    expect(rows).toContainEqual(["machines", "projects \u00b7 today"]);
    expect(lines.at(-1)).not.toMatch(/[┐┌‹›]/u);
    const ledger = lines.join("\n");
    expect(ledger).toContain("○ Ship the ledger board today. · 5h");
    expect(ledger).toContain("Does l open the full screen? · 2h");
    expect(ledger).toContain("● Yes. l takes the full screen, and the cursor op\u2026 · 25m");
    expect(ledger).not.toContain("owe you");
  });

  test("reads the conversation newest-last with one line per message on a 240 column screen", () => {
    const text = texts(240, 60).join("\n");
    expect(text).toContain("○ Ship the ledger board today. · 5h");
    expect(text).toContain("● The compact box keeps one line per message. · 4h");
    expect(text).toContain("Yes. l takes the full screen, and the cursor opens");
  });

  test("opens the queue counts as the shared box's first line on a 120 column screen", () => {
    const lines = bandedDrawn(120, 40, [], bandedReadings("east")).block.map(plain);
    const tabs = lines.findIndex((line) => line.includes("queue | scheduled"));
    expect(lines.at(tabs + 1)).toContain("4 running · 1 waiting · 2 queued in pueue");
  });

  test("draws each quota row with a pace bar and a reserve column under its header's run-out figure", () => {
    const text = texts(120, 40).join("\n");
    expect(text).toContain("● claude main · max · runs out in 1d 20h");
    expect(text).toContain("● opencode-go · runs out in 22d");
    expect(text).toContain("98%");
    expect(text).toContain("┃");
    expect(text).toContain("spare");
    expect(text).toContain("1h 11m");
    expect(text).not.toMatch(/runs out in 1h 11m/u);
  });

  test("opens the gluttons first and swaps the shared box to the alerts with the gluttons count kept", () => {
    const text = texts(120, 40).join("\n");
    expect(text).toContain("⚑ shop is spending over its share");
    expect(text).not.toContain("quota-pace");
    const alerts = bandedDrawn(120, 40, [{ press: "a" }]).block.map(plain).join("\n");
    expect(alerts).toContain("quota-pace");
    expect(alerts).toContain("gluttons: 4 flags, shop and my-home over their share");
  });

  test("draws each machine on one line with its usage numbers coloured by how high they run", () => {
    const { block } = bandedDrawn(240, 60);
    const south = block.find((line) => plain(line).includes("south  cpu"));
    expect(plain(south ?? []).slice(0, 60).trim()).toMatch(/^│ south +cpu 42% +mem \S+ +gpu 63% +disk 19%/u);
    expect((south ?? []).filter((part) => part.text.includes("%")).map((part) => part.style.tone)).toEqual(["success", "warning", "success"]);
  });

  test("flags a task over half the cores under this machine", () => {
    const readings = bandedReadings();
    const { levels } = readings.tasks;
    const episode = { limit: "cores" as const, from: readings.now, to: readings.now, ongoing: true };
    const projects = levels.projects.map((project) => ({
      ...project,
      tasks: project.tasks.map((task) => (task.id === "tasks-bridge-plot" ? { ...task, episodes: [episode] } : task)),
    }));
    const modified = { ...levels, projects };
    const byMachine = new Map(readings.tasks.byMachine).set(modified.machine, modified);
    const lines = bandedDrawn(240, 60, [], { ...readings, tasks: { ...readings.tasks, levels: modified, byMachine } }).block.map(plain);
    // The flag stands under this machine while the other machine, whose task usage is never read here, claims no all clear.
    const flag = lines.findIndex((line) => line.includes("⚑ tasks-bridge-plot uses over half the cores"));
    const unread = lines.findIndex((line) => line.includes("task usage not read"));
    expect([flag >= 0, unread > flag, lines.some((line) => line.includes("no task over its share"))]).toEqual([true, true, false]);
  });

  test("keeps the what column of a launch agent's interval row where the timed rows have it", () => {
    const readings = bandedReadings();
    const agents = [
      { kind: "agent" as const, name: "org.nix-community.home.sync", calendar: [], everySeconds: 3600 },
      { kind: "agent" as const, name: "org.nix-community.home.slow", calendar: [], everySeconds: 12 * 3600 + 5 * 60 },
    ];
    const timer = { kind: "timer" as const, name: "backup", next: DateTime.addDuration(readings.now, "12 minutes") };
    const lines = scheduledLines({
      schedules: [
        { source: "agent", outcome: ok(agents), unread: [] },
        { source: "timer", outcome: ok([timer]), unread: [] },
      ],
      pueues: [{ name: "north", status: Option.none() }],
      orchestrators: [{ machine: "north", listing: unscheduled() }],
    });
    const timeAndWhat = (what: string) => {
      const line = lines.find((text) => text.includes(what)) ?? "";
      const whatAt = line.indexOf(what);
      return [whatAt, line.slice(line.lastIndexOf("│ ", whatAt) + 2, whatAt)];
    };
    const [timerWhatAt] = timeAndWhat("backup");
    expect([timeAndWhat("org.nix-community.home.sync"), timeAndWhat("org.nix-community.home.slow")]).toEqual([
      [timerWhatAt, expect.stringMatching(/^every 1h 0m +$/u)],
      [timerWhatAt, expect.stringMatching(/^every 12h 5m +$/u)],
    ]);
  });

  test("shows the screenshot's box as one quiet line without the vendor updater", () => {
    const lines = scheduledLines({
      schedules: [
        {
          source: "agent",
          outcome: ok([{ kind: "agent" as const, name: "com.google.GoogleUpdater.wake", calendar: [], everySeconds: 3600 }]),
          unread: [],
        },
      ],
      pueues: [{ name: "north", status: emptyPueue }],
      orchestrators: [{ machine: "north", listing: unscheduled() }],
    });
    const text = lines.join("\n");
    expect(text).not.toContain("GoogleUpdater");
    expect(lines.filter((line) => line.includes("nothing scheduled"))).toHaveLength(1);
    for (const words of ["no delayed jobs", "no dated item", "no launch agent set"]) expect(text).not.toContain(words);
    expect(titleRows(lines)).toContainEqual(["queue | scheduled"]);
  });

  test("says nothing else scheduled once the rows cover every source", () => {
    const readings = bandedReadings();
    const timer = { kind: "timer" as const, name: "backup", next: DateTime.addDuration(readings.now, "12 minutes") };
    const lines = scheduledLines({
      schedules: [{ source: "timer", outcome: ok([timer]), unread: [] }],
      pueues: [{ name: "north", status: emptyPueue }],
      orchestrators: [{ machine: "north", listing: unscheduled() }],
    });
    const text = lines.join("\n");
    expect(text).toContain("backup");
    expect(text).toContain("nothing else scheduled");
  });

  test("names the source in plain words while its schedules are still reading or have failed", () => {
    const started = scheduledLines({ pueues: [{ name: "north", status: Option.none() }], orchestrators: [{ machine: "north", listing: { kind: "pending" } }] }).join("\n");
    expect(started).toContain("reading the delayed jobs\u2026");
    expect(started).toContain("reading the dated items\u2026");
    const text = scheduledLines({
      schedules: [],
      pueues: [{ name: "north", status: Option.some({ kind: "unreachable" as const, reason: "pueue down" }) }],
      orchestrators: [{ machine: "north", listing: { kind: "invalid" as const, issue: "bad yaml" } }],
    }).join("\n");
    expect(text).toContain("delayed jobs unreachable: pueue down");
    expect(text).toContain("dated items invalid: bad yaml");
  });

  test("names the failed machine in scheduled failure lines", () => {
    const text = scheduledLines({
      schedules: [],
      pueues: [
        { name: "north", status: emptyPueue },
        { name: "south", status: Option.some({ kind: "unreachable" as const, reason: "daemon down" }) },
      ],
      orchestrators: [
        { machine: "north", listing: unscheduled() },
        { machine: "south", listing: { kind: "invalid" as const, issue: "bad yaml" } },
      ],
    }).join("\n");
    expect(text).toContain("delayed jobs south unreachable: daemon down");
    expect(text).toContain("dated items south invalid: bad yaml");
  });

  test("shows the machines, the projects, the tasks and the task picked at once on a 240 column screen", () => {
    const onBridge: ReadonlyArray<Step> = [{ move: "in" }, { move: "in" }, { move: "in" }];
    expect(titleRows(texts(240, 60, onBridge))).toContainEqual([
      "machines",
      "projects · today",
      "harbor · tasks",
      "tasks-bridge-plot",
    ]);
  });

  test("shows one projects board with both machines' projects in it", () => {
    const lines = texts(240, 60);
    expect(titleRows(lines)).toContainEqual(["machines", "projects · today", "harbor · tasks"]);
    expect(titleRows(lines)).toContainEqual(["queue | scheduled"]);
    const board = lines.findIndex((line) => line.includes("project") && line.includes("work"));
    const rows = lines.slice(board + 1, board + 5).join("\n");
    for (const project of ["harbor", "kelp"]) expect(rows).toContain(project);
    expect(rows).not.toContain("notes");
    expect(rows.match(/\bkelp\b/gu)?.length).toBe(1);
    expect(texts(240, 60, [{ move: "down" }]).join("\n")).toContain("tasks-kelp-tend");
  });

  test("lists every done task on the same board once the interval switches to all", () => {
    const lines = texts(240, 60, [{ press: "t" }]);
    expect(titleRows(lines)).toContainEqual(["machines", "projects · all", "harbor · tasks"]);
    const board = lines.findIndex((line) => line.includes("project") && line.includes("work"));
    expect(lines.slice(board + 1, board + 6).join("\n")).toContain("notes");
  });

  test("keeps one row for a project on both machines and names each task's machine", () => {
    const readings = bandedReadings();
    const south = taskLevels(southTaskReadings({ machine: "south" }));
    const harborSouth = { ...south, projects: south.projects.map((project) => ({ ...project, name: "harbor", tasks: project.tasks.map((task) => ({ ...task, project: "harbor" })) })) };
    const byMachine = new Map([[readings.tasks.levels.machine, readings.tasks.levels], ["south", harborSouth]]);
    const lines = bandedLines(240, 60, [], { ...readings, tasks: { ...readings.tasks, byMachine } });
    const board = lines.findIndex((line) => line.includes("project") && line.includes("work"));
    expect(lines.slice(board + 1, board + 4).join("\n").match(/\bharbor\b/gu)?.length).toBe(1);
    const tasks = lines.findIndex((line) => line.includes("task") && line.includes("machine"));
    expect(tasks).toBeGreaterThan(-1);
    const text = lines.join("\n");
    expect(text).toContain("tasks-kelp-tend");
    expect(text).toMatch(/tasks-kelp-tend +working +south/u);
    expect(text).toMatch(/tasks-bridge-plot +working +north/u);
    const ticket: ReadonlyArray<Step> = [{ move: "in" }, { move: "in" }, { move: "down" }, { move: "in" }];
    const single = bandedLines(240, 60, ticket, { ...readings, tasks: { ...readings.tasks, byMachine } }).join("\n");
    expect(single).toMatch(/running for .* \u00B7 south/u);
  });

  test("names each task's machine on a project one machine holds, while the other machine has no task", () => {
    const readings = bandedReadings();
    const south = taskLevels(southTaskReadings({ machine: "south" }));
    const byMachine = new Map([[readings.tasks.levels.machine, readings.tasks.levels], ["south", { ...south, projects: [] }]]);
    const text = bandedLines(240, 60, [], { ...readings, tasks: { ...readings.tasks, byMachine } }).join("\n");
    expect(text).toMatch(/task +state +machine /u);
    expect(text).toMatch(/tasks-bridge-plot +working +north/u);
  });

  test("lists both machines' runs with the CI runs and says which repository it could not read", () => {
    const lines = texts(240, 60);
    expect(lines.some((line) => /│ ▶ pueue north unknown sleep 800/u.test(line))).toBe(true);
    expect(lines.some((line) => /│ ▶ pueue south kelp bun test/u.test(line))).toBe(true);
    expect(lines.some((line) => /│ ▶ CI {10}shop ci +3m +now │/u.test(line))).toBe(true);
    expect(lines.some((line) => /│ · CI {10}shop deploy +– +waiting │/u.test(line))).toBe(true);
    expect(lines.some((line) => /│ ✗ CI {10}shop ci +2m +19:28 │/u.test(line))).toBe(true);
    expect(lines.join("\n")).toContain("! CI runs of blog not read");
    const next = bandedDrawn(240, 60, [{ press: "s" }]).block.map(plain);
    expect(next.join("\n")).toContain("! schedules of blog not read");
  });

  test("says nothing ran only once pueue and the CI runs have answered", () => {
    const readings = bandedReadings();
    const queueText = (status: Option.Option<ReturnType<typeof decodePueue>>, ci: BandedReadings["ci"]): string => {
      const queues = { machines: [{ name: "north", status }], actions: { repo: "example/shop", runs: Option.some(ok([])) } };
      return bandedDrawn(240, 60, [], { ...readings, queues, ci }).block.map(plain).join("\n");
    };
    const answered: BandedReadings["ci"] = { kind: "live", value: { ...ok({ repos: ["example/shop"], runs: [], failures: [] }), capturedAt: readings.now }, at: DateTime.toEpochMillis(readings.now) };
    const pending = queueText(Option.none(), { kind: "pending" });
    expect([pending.includes("reading pueue…"), pending.includes("reading the CI runs…"), pending.includes("nothing ran")]).toEqual([true, true, false]);
    expect(queueText(emptyPueue, { kind: "pending" }).includes("nothing ran")).toBe(false);
    expect(queueText(emptyPueue, answered).includes("nothing ran in the last day")).toBe(true);
  });

  test("names no machine on a queue read from one machine alone", () => {
    const readings = bandedReadings();
    const queues = ({
      machines: [{ name: "north", status: Option.some(decodePueue(fixture("pueue/status.json"))) }],
      actions: { repo: "example/shop", runs: Option.some(ok([])) },
    });
    const text = bandedDrawn(240, 60, [], { ...readings, queues }).block.map(plain).join("\n");
    expect(text).toMatch(/│ ▶ pueue unknown sleep 800/u);
    expect(text).not.toMatch(/pueue north/u);
  });

  test("keeps this machine's rows while the other machine's pueue is still reading", () => {
    const readings = bandedReadings();
    const north = { name: "north", status: Option.some(decodePueue(fixture("pueue/status.json"))) };
    const queues = ({
      machines: [north, { name: "south", status: Option.none() }],
      actions: { repo: "example/shop", runs: Option.some(ok([])) },
    });
    const text = bandedDrawn(240, 60, [], { ...readings, queues }).block.map(plain).join("\n");
    expect(text).toContain("reading pueue…");
    expect(text).toMatch(/│ ▶ pueue unknown sleep 800/u);
  });

  test("names the machine whose pueue could not be read", () => {
    const readings = bandedReadings();
    const north = { name: "north", status: Option.some(decodePueue(fixture("pueue/status.json"))) };
    const reason = "ssh: connect to host south: refused";
    const queues = ({
      machines: [north, { name: "south", status: Option.some({ kind: "unreachable" as const, reason }) }],
      actions: { repo: "example/shop", runs: Option.some(ok([])) },
    });
    const text = bandedDrawn(240, 60, [], { ...readings, queues }).block.map(plain).join("\n");
    expect(text).toContain(`pueue south ✗ unreachable: ${reason}`);
  });

  test("gives a machine with a tasks report and no resources reading its own row in the machines box", () => {
    const readings = bandedReadings();
    const byMachine = new Map(readings.tasks.byMachine).set("east", taskLevels(southTaskReadings({ machine: "east" })));
    const { block, targets } = bandedDrawn(240, 60, [], { ...readings, tasks: { ...readings.tasks, byMachine } });
    const lines = block.map(plain);
    const top = lines.findIndex((line) => titlesOn(line).some((title) => title === "machines"));
    const eastRow = top + 1 + lines.slice(top + 1).findIndex((line) => /^│ east/u.test(line));
    expect(lines.at(eastRow)).toContain("east");
    expect(targets.filter((target) => target.row === eastRow)).toEqual([]);
    expect(titleRows(lines)).toContainEqual(["machines", "projects · today", "kelp · tasks"]);
    expect(lines.join("\n")).toContain("tasks-kelp-tend");
  });

  test("says a machine's tasks were not checked when its tasks report fails", () => {
    const readings = bandedReadings();
    const failed = taskLevels(southTaskReadings({ tasks: { kind: "unreachable", reason: "ssh: connect to host south: Connection refused" } }));
    const byMachine = new Map(readings.tasks.byMachine).set("south", failed);
    const text = bandedDrawn(240, 60, [], { ...readings, tasks: { ...readings.tasks, byMachine } }).block.map(plain).join("\n");
    expect(text).toContain("! tasks report not read, so no task is checked against the machine");
    expect(text.split("no task over its share").length - 1).toBe(1);
  });

  test("wraps an unreachable machine's ssh error inside the machines box without losing a word", () => {
    const readings = bandedReadings();
    const reason = "sh exited 255: ssh: connect to host south port 22: Connection refused";
    const machines = Option.some(machinesView({ name: "north", view: recordedResources() }, [{ name: "south", reading: { kind: "unreachable", reason } }], dashboardNow));
    const frame = bandedDrawn(240, 60, [], { ...readings, machines }).block.map(plain);
    const top = frame.findIndex((line) => titlesOn(line).some((title) => title === "machines"));
    const below = frame.slice(top + 1);
    const boxed = below
      .slice(0, below.findIndex((line) => titlesOn(line).some((title) => title === "queue | scheduled")))
      .map((line) => line.slice(0, 80))
      .filter((line) => line.startsWith("│"))
      .map((line) => line.slice(1, -1).trim())
      .join(" ");
    expect(boxed.replaceAll(/\s+/gu, " ")).toContain(`✗ unreachable: ${reason}`);
  });

  for (const [columns, rows] of [[120, 40], [240, 60]] as const) {
    test(`keeps the pueue label and every word of its failure inside the queue box at ${columns} columns`, () => {
      const readings = bandedReadings();
      const reason = "pueue exited 1: Error: 0: Couldn't find a pueue configuration file";
      const queues = ({
        machines: [{ name: "north", status: Option.some({ kind: "unreachable" as const, reason }) }],
        actions: { repo: "example/shop", runs: Option.some(ok([])) },
      });
      const lines = bandedDrawn(columns, rows, [], { ...readings, queues }).block.map(plain);
      const top = lines.findIndex((line) => line.includes("queue | scheduled"));
      const edge = lines[top]?.indexOf("╮") ?? 0;
      const boxed = lines
        .slice(top + 1)
        .map((line) => line.slice(0, edge + 1))
        .filter((line) => line.startsWith("│"))
        .map((line) => line.slice(1, -1).trim())
        .join(" ");
      const text = boxed.replaceAll(/\s+/gu, " ");
      expect(text).toContain(`pueue ✗ unreachable: ${reason}`);
      expect(text).not.toContain("pueue pueue");
    });
  }
  test("keeps an overlong hostname in a pueue failure without dropping its tail", () => {
    const host = "build-runner-01.ci.production.example.internal.example.com";
    const reason = `ssh: connect to host ${host} port 22: Connection refused`;
    const queues = ({
      machines: [{ name: "north", status: Option.some({ kind: "unreachable" as const, reason }) }],
      actions: { repo: "example/shop", runs: Option.some(ok([])) },
    });
    const lines = bandedDrawn(120, 40, [], { ...bandedReadings(), queues }).block.map(plain);
    const top = lines.findIndex((line) => line.includes("queue | scheduled"));
    const edge = lines[top]?.indexOf("╮") ?? 0;
    const boxed = lines
      .slice(top + 1)
      .map((line) => line.slice(0, edge + 1))
      .filter((line) => line.startsWith("│"))
      .map((line) => line.slice(1, -1).trim())
      .join(" ");
    expect(boxed.replaceAll(/\s+/gu, "")).toContain(host);
    expect(boxed).not.toContain("…");
  });

  for (const [tasks, said] of [
    [{ kind: "unreachable", reason: "ssh: connect to host south: Connection refused" }, "! tasks report not read, so no task is checked against the machine"],
    [{ kind: "pending" }, "checking the tasks…"],
  ] as const) {
    test(`says "${said}" under a machine whose sampled tasks outlive an unread report`, () => {
      const readings = bandedReadings();
      const sample: TaskSampleRecord = {
        schemaVersion: 1,
        at: DateTime.makeUnsafe("2026-10-18T08:00:00Z"),
        machine: { cores: 16, memoryBytes: 47 * 1024 ** 3 },
        task: { id: "tasks-kelp-tend", title: "Tend the kelp lines", project: "kelp", state: "working", firstStartedAt: DateTime.makeUnsafe("2026-10-17T21:40:00Z"), endedAt: null },
        usage: { processes: [{ identity: "1900 2026-10-18T07:00:00Z", ownSeconds: 300 }], cpuCores: 0.5, residentBytes: 1024 ** 3 },
        spend: null,
        tests: [],
      };
      const unread = taskLevels(southTaskReadings({ tasks, samples: [sample] }));
      const byMachine = new Map(readings.tasks.byMachine).set("south", unread);
      const text = bandedDrawn(240, 60, [], { ...readings, tasks: { ...readings.tasks, byMachine } }).block.map(plain).join("\n");
      expect([unread.projects.map((project) => project.name), text.includes(said), text.split("no task over its share").length - 1]).toEqual([["kelp"], true, 1]);
    });
  }

  test("claims no all clear under this machine when its task processes are not read", () => {
    const readings = bandedReadings();
    const unmeasured = taskLevels(taskReadings({ live: { kind: "unreachable", reason: "ps: not found" } }));
    const byMachine = new Map(readings.tasks.byMachine).set("north", unmeasured);
    const text = bandedDrawn(240, 60, [], { ...readings, tasks: { ...readings.tasks, levels: unmeasured, byMachine } }).block.map(plain).join("\n");
    expect([text.split("task usage not read").length - 1, text.includes("no task over its share")]).toEqual([2, false]);
  });

  test("clears the other machine once its live usage reads", () => {
    const readings = bandedReadings();
    const measured = taskLevels(southTaskReadings({ live: ok(live()) }));
    const byMachine = new Map(readings.tasks.byMachine).set("south", measured);
    const text = bandedDrawn(240, 60, [], { ...readings, tasks: { ...readings.tasks, byMachine } }).block.map(plain).join("\n");
    expect([text.includes("task usage not read"), text.split("no task over its share").length - 1]).toEqual([false, 2]);
  });

  test("holds the other machine without an all clear when its live usage fails", () => {
    const readings = bandedReadings();
    const unread = taskLevels(southTaskReadings({ live: { kind: "unreachable", reason: "ssh: connect to host south: Connection refused" } }));
    const byMachine = new Map(readings.tasks.byMachine).set("south", unread);
    const text = bandedDrawn(240, 60, [], { ...readings, tasks: { ...readings.tasks, byMachine } }).block.map(plain).join("\n");
    expect([text.includes("task usage not read"), text.split("no task over its share").length - 1]).toEqual([true, 1]);
  });

  test("flags the other machine's task over a quarter of memory from its live usage", () => {
    const heavy: LiveTasks = {
      samples: {
        intervalSeconds: 1,
        startPrecisionMillis: 1010,
        before: [],
        after: [
          {
            identity: "100 1791129600000",
            pid: 100,
            parent: 1,
            startedAtMillis: DateTime.toEpochMillis(at("2026-10-19T00:00:00Z")),
            ownSeconds: 0,
            waitedChildSeconds: 0,
            residentBytes: 3 * gib,
            folder: "/home/example/work/kelp",
          },
        ],
      },
      programs: new Map([[100, "bun"]]),
      memoryBytes: 8 * gib,
    };
    const readings = bandedReadings();
    const flagged = taskLevels(southTaskReadings({ live: ok(heavy) }));
    const byMachine = new Map(readings.tasks.byMachine).set("south", flagged);
    const text = bandedDrawn(240, 60, [], { ...readings, tasks: { ...readings.tasks, byMachine } }).block.map(plain).join("\n");
    expect(text).toContain("uses over a quarter of memory");
    expect(text.split("no task over its share").length - 1).toBe(1);
  });

  test("opens a project's tasks by a click on its row, and no click on a machine name", () => {
    const { targets } = bandedDrawn(240, 60);
    const lines = texts(240, 60);
    const below = targets.filter((target) => target.row > 0);
    expect(below.length).toBeGreaterThan(0);
    const machineRow = lines.findIndex((line) => line.includes("north  cpu"));
    expect(below.filter((target) => target.row === machineRow)).toEqual([]);
    const kelp = below.find((target) => lines.at(target.row)?.slice(target.from, target.to).includes("kelp") === true);
    const clicked: ReadonlyArray<string> = kelp === undefined ? [] : bandedScreen().draw(0, kelp.state, 240, 60).block.map(plain);
    expect(clicked).toEqual(bandedLines(240, 60, [{ move: "down" }, { move: "in" }, { move: "in" }]));
  });
});

describe("the banded dashboard, against its pinned recordings", () => {
  for (const [columns, rows] of [[240, 60], [120, 40]] as const) {
    test(`renders the pinned frame at ${columns}x${rows}`, () => {
      expect(`${texts(columns, rows).map((line) => line.trimEnd()).join("\n")}\n`).toBe(fixture(`screens/dashboard-${columns}x${rows}.txt`));
    });
  }
});
