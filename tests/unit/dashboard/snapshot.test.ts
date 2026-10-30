import { describe, expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { DateTime, Effect, Option } from "effect";
import {
  type PueueView,
  type QueuesView,
  unreachable,
  composedSessionQuota,
  machinesView,
  ok,
  type RemoteResources,
  type ResourcesView,
  type SessionQuotaView,
} from "@tui-dash/schema";
import { queuesSection } from "@tui-dash/queues";
import { blockDocument, type Block, frameText, lineWidth, plain } from "@tui-dash/ui";
import { dashboardNow as now, quotaBlocksOf as blocksOf, recordedResources as view, southResources } from "../../lib/dashboard-fixture";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";
import { machineView, southReading } from "../../lib/machines-fixture";
import { glanceBlock } from "../../lib/host-fixture";
import { fixtureQueueReadings, fixtureQueues } from "../../lib/queues-fixture";
import { fixtureSessionView, fiveHourAheadSessionView } from "../../lib/session-fixture";

const width = 84;

const standardRows = 24;

const sessions = () => Option.some(fixtureSessionView());

const blocks = () => blocksOf(fixture("quota-axi/full.json"));

// The same report with every pace removed, as a window whose pace quota-axi could not work out arrives.
const unpacedQuotaText = (): string =>
  JSON.stringify(JSON.parse(fixture("quota-axi/full.json"), (key, value) => (key === "pace" ? undefined : value)));

const alone = (resources: ResourcesView) => Option.some(machinesView({ name: "north", view: resources }, [], now));

const glanceRows = (over: Parameters<typeof glanceBlock>[0], columns: number, rows: number): Block =>
  glanceBlock({ queues: fixtureQueueReadings(), ...over }, columns, rows);

const printed = (rows = Number.POSITIVE_INFINITY, columns = width, shown = sessions(), quota = blocks()): ReadonlyArray<string> =>
  glanceRows({ blocks: quota, sessions: shown, machines: alone(view()) }, columns, rows).map(plain);

const glance = <L>(lines: ReadonlyArray<L>, text: (line: L) => string): ReadonlyArray<L> => {
  const start = lines.findIndex((line) => text(line).startsWith("alerts"));
  if (start === -1) return lines;
  return lines.slice(0, text(lines[start - 1]) === "" ? start - 1 : start);
};

const rowOf = (lines: ReadonlyArray<string>, account: string, name: string): string => {
  const start = lines.findIndex((line) => line.startsWith(`● ${account}`));
  const end = lines.findIndex((line, index) => index > start && !line.startsWith("  "));
  const row = lines.slice(start + 1, end === -1 ? undefined : end).find((line) => line.startsWith(`  ${name} `));
  if (start === -1 || row === undefined) throw new Error(`no ${name} row under ${account}`);
  return row;
};

const limitNames = (lines: ReadonlyArray<string>, account: string): ReadonlyArray<string> => {
  const start = lines.findIndex((line) => line.startsWith(`● ${account}`));
  const end = lines.findIndex((line, index) => index > start && !line.startsWith("  "));
  return lines.slice(start + 1, end).map((line) => /^ {2}(\S+(?: \S+)?) {2,}|^ {2}(\S+(?: \S+)?) +[━╸─\d]/u.exec(line)?.slice(1).find(Boolean) ?? line);
};

const rendered = async (rows: Block, columns: number, height: number): Promise<string> => {
  const setup = await createTestRenderer({ width: columns, height });
  setup.renderer.root.add(new TextRenderable(setup.renderer, { content: blockDocument(rows) }));
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  await setup.dispose();
  return frame;
};

describe("the dashboard names every limit by its length", () => {
  test("in one set of words for every account", () => {
    const lines = printed();
    expect(limitNames(lines, "claude main")).toEqual(["5 hours", "week", "fable week"]);
    expect(limitNames(lines, "claude second")).toEqual(["week"]);
    expect(limitNames(lines, "codex")).toEqual(["5 hours", "week"]);
    expect(limitNames(lines, "opencode-go")).toEqual(["5 hours", "week", "month"]);
  });
});

describe("the dashboard names every limit by its length without its pace", () => {
  test("in the same words as with it", () => {
    const lines = printed(Number.POSITIVE_INFINITY, width, sessions(), blocksOf(unpacedQuotaText()));
    expect(limitNames(lines, "claude main")).toEqual(["5 hours", "week", "fable week"]);
    expect(limitNames(lines, "claude second")).toEqual(["week"]);
    expect(limitNames(lines, "codex")).toEqual(["5 hours", "week"]);
    expect(limitNames(lines, "opencode-go")).toEqual(["5 hours", "week", "month"]);
  });
});

describe("the dashboard draws the pace marker on every paced limit", () => {
  test("at the window's time-remaining percent", () => {
    const lines = printed();
    for (const name of ["5 hours", "week", "fable week"]) {
      expect(rowOf(lines, "claude main", name)).toContain("\u2503");
    }
    expect(rowOf(lines, "codex", "week")).toContain("\u2503");
    expect(rowOf(lines, "opencode-go", "month")).toContain("\u2503");
  });

  test("and draws none where the window has no pace", () => {
    expect(rowOf(printed(), "claude second", "week")).not.toContain("\u2503");
    const lines = printed(Number.POSITIVE_INFINITY, width, sessions(), blocksOf(unpacedQuotaText()));
    for (const name of ["5 hours", "week", "fable week"]) {
      expect(rowOf(lines, "claude main", name)).not.toContain("\u2503");
    }
  });
});

describe("the dashboard says how much is left, whether it lasts, and when it resets", () => {
  const lines = printed();

  test("for a limit that lasts", () => {
    expect(rowOf(lines, "claude main", "5 hours")).toMatch(/ 98% left +resets in 1h 11m$/u);
  });

  test("for a limit projected to run out before its reset", () => {
    expect(rowOf(lines, "claude main", "week")).toMatch(/ 31% left {2}runs out in 1d 20h +resets in 2d 20h$/u);
    expect(rowOf(lines, "opencode-go", "month")).toMatch(/ 81% left {2}runs out in 22d +resets in 25d$/u);
  });

  test("for a projection made too early to trust", () => {
    expect(rowOf(lines, "codex", "week")).toMatch(/ 82% left {2}may run out in 2d 7h +resets in 6d 11h$/u);
  });

  test("keeping the reset's words when the bar gives way at 60 columns", () => {
    expect(rowOf(printed(Number.POSITIVE_INFINITY, 60), "claude main", "week")).toMatch(/ 31%.* {2}runs out in 1d 20h +resets in 2d 20h$/u);
  });

  test("keeping every run-out figure whole in a 30 column terminal", () => {
    const narrow = printed(Number.POSITIVE_INFINITY, 30);
    const limits = narrow.slice(0, narrow.indexOf(""));
    expect(limits.join("\n")).not.toContain("…");
    expect(limits).toEqual(expect.arrayContaining(["    runs out in 1d 20h", "    may run out in 2d 7h", "    runs out in 22d"]));
  });

  test("for a limit with nothing left", () => {
    const spent = blocksOf(fixture("quota-axi/full.json").replace('"percentRemaining": 98', '"percentRemaining": 0'));
    expect(rowOf(printed(Number.POSITIVE_INFINITY, width, sessions(), spent), "claude main", "5 hours")).toMatch(/ {3}0% left {2}used up +resets in 1h 11m$/u);
  });
});

describe("the dashboard names each agent spending over its share of a running-ahead limit", () => {
  test("by its project, beside the account and the limit", () => {
    expect(printed().filter((line) => line.startsWith("⚑")).toSorted()).toEqual([
      "⚑ a no-mistakes run is spending over its share of claude main's week",
      "⚑ my-home is spending over its share of claude main's week",
      "⚑ my-home is spending over its share of opencode-go's month",
      "⚑ shop is spending over its share of claude main's week",
    ]);
  });

  test("and says so when no agent is flagged", () => {
    const calm = fixtureSessionView();
    const unflagged: SessionQuotaView = {
      ...calm,
      accounts: calm.accounts.map((account) =>
        account.body.kind !== "windows"
          ? account
          : {
              ...account,
              body: {
                ...account.body,
                windows: account.body.windows.map((window) => ({
                  ...window,
                  sessions: window.sessions.map((row) => ({ ...row, flagged: false })),
                })),
              },
            },
      ),
    };
    const lines = printed(Number.POSITIVE_INFINITY, width, Option.some(unflagged));
    expect(lines).toContain("no agent flagged for spending a limit too fast");
    expect(lines.some((line) => line.startsWith("⚑"))).toBe(false);
    expect(printed(Number.POSITIVE_INFINITY, 30, Option.some(unflagged))).toEqual(
      expect.arrayContaining(["no agent flagged for spending", "a limit too fast"]),
    );
  });

  test("and says which machine it could not check", () => {
    const southDown = composedSessionQuota(machineView("north"), "north", [southReading({ kind: "unreachable", reason: "ssh: connect to host south: Connection refused" })]);
    expect(printed(Number.POSITIVE_INFINITY, width, Option.some(southDown))).toContain("! south not checked, so its agents are not flagged");
    expect(printed(Number.POSITIVE_INFINITY, 30, Option.some(southDown))).toEqual(
      expect.arrayContaining(["! south not checked, so its", "  agents are not flagged"]),
    );
  });

  test("and says it is still checking before the session logs are read", () => {
    expect(printed(Number.POSITIVE_INFINITY, width, Option.none())).toContain("reading the agents…");
  });
});

describe("the dashboard states the machine in a line", () => {
  test("with its cpu and memory, then each gpu", () => {
    const lines = printed();
    expect(lines).toContain("machine  cpu 11% · memory 5.5G of 31.3G");
    expect(lines).toContain("gpu      NVIDIA GeForce RTX 3080 Laptop GPU · 9% · memory 1.8G of 16.0G");
  });

  test("and keeps each gpu reading whole in a 30 column terminal, cutting only the gpu's name", () => {
    expect(printed(Number.POSITIVE_INFINITY, 30)).toEqual(
      expect.arrayContaining(["gpu      NVIDIA GeForce RTX 3…", "         9%", "         memory 1.8G of 16.0G"]),
    );
  });
});

describe("the dashboard keeps jargon off the main screen", () => {
  const words = [/pp\b/u, /\braw\b/u, /\bfair\b/u, /assumed/u, /#[0-9a-f]{6}/u, /w[12][AB]:p2/u, /a1b2c3/u, /\bpids?\b/iu, /\bload\b/u, /quota-axi/u, /\bpace\b/u, /estimates/u];

  for (const [columns, rows] of [[84, 24], [84, 60], [60, 24], [30, 40]] as const) {
    test(`in a ${columns}x${rows} terminal`, async () => {
      const lines = glanceRows({ blocks: blocks(), sessions: sessions(), machines: alone(view()) }, columns, rows);
      const frame = await rendered(glance(lines, plain), columns, rows);
      for (const word of words) expect(frame).not.toMatch(word);
      expect(frame).not.toContain("3809535");
    });
  }
});

describe("the dashboard fits the terminal it runs in", () => {
  for (const [columns, rows] of [[84, 24], [60, 24], [30, 30]] as const) {
    test(`keeps every live account, all four flags shown or counted, the queues, the machine and every alert rule inside a ${columns}x${rows} terminal`, () => {
      const lines = glanceRows({ blocks: blocks(), sessions: sessions(), machines: alone(view()) }, columns, rows);
      expect(lines.length).toBeLessThanOrEqual(rows);
      for (const line of lines) expect(lineWidth(line)).toBeLessThanOrEqual(columns);
      const text = lines.map(plain).join("\n");
      for (const header of ["● claude main", "● codex", "● opencode-go"]) expect(text).toContain(header);
      expect(text.includes("● claude second") || text.includes("+1 more claude profiles")).toBe(true);
      expect((text.match(/⚑/gu)?.length ?? 0) + Number(/^\+(\d+) more flags?$/mu.exec(text)?.[1] ?? 0)).toBe(4);
      expect(text).toContain("queue    north · 2 running");
      expect(text).toContain("actions  toolshed · 2 running");
      expect(text).toContain("machine  cpu 11%");
      for (const rule of ["quota-pace", "heavy-load", "long-task"]) expect(text).toMatch(new RegExp(`^${rule} `, "mu"));
    });
  }

  test("the print path renders every line it laid out", async () => {
    const rows = glanceRows({ blocks: blocks(), sessions: sessions(), machines: alone(view()) }, width, Number.POSITIVE_INFINITY);
    const frame = await Effect.runPromise(frameText(blockDocument(rows), width, rows.length + 1));
    expect(frame.split("\n")).toEqual(rows.map((line) => plain(line).trimEnd()));
  });
});

const alertsNow = DateTime.makeUnsafe("2026-10-19T19:20:00Z");

const freshSessionsAtAlerts = (): Option.Option<SessionQuotaView> => {
  const fresh = fixtureSessionView();
  const readAt = DateTime.makeUnsafe("2026-10-19T19:19:00Z");
  return Option.some({
    ...fresh,
    now: alertsNow,
    accounts: fresh.accounts.map((account) =>
      account.body.kind !== "windows"
        ? account
        : {
            ...account,
            body: {
              ...account.body,
              windows: account.body.windows.map((window) => ({
                ...window,
                source: window.source.kind === "quota-axi" ? { ...window.source, readAt } : { ...window.source, observedAt: readAt },
              })),
            },
          }),
  });
};

const withAlertsAt = (rows: number): ReadonlyArray<string> =>
  glanceRows({ blocks: blocks(), sessions: freshSessionsAtAlerts(), machines: alone(view()), now: alertsNow }, width, rows).map(plain);

const summaryAt1920 = [
  "alerts",
  "quota-pace none recorded",
  "heavy-load 40m ago · expected, a nightly baseline runs on south",
  "long-task  10m ago · no verdict on this fire",
  "nightly    none recorded",
];

describe("the dashboard's alerts panel", () => {
  test("follows the machine whole, with each rule's limits, last fire and verdict, when the terminal is tall", () => {
    const lines = withAlertsAt(Number.POSITIVE_INFINITY);
    const start = lines.indexOf("alerts");
    expect(start).toBeGreaterThan(lines.findIndex((line) => line.startsWith("gpu ")));
    expect(lines[start - 1]).toBe("");
    expect(`${lines.slice(start).join("\n")}\n`).toBe(fixture("screens/alerts-84x18.txt"));
  });

  test("keeps a row for each rule in a standard 84x24 terminal, where the saved profile gives way", () => {
    const shown = withAlertsAt(standardRows);
    expect(shown).toHaveLength(standardRows);
    expect(shown.slice(-summaryAt1920.length)).toEqual(summaryAt1920);
    expect(shown).toContain("+1 more claude profiles");
    expect(shown.filter((line) => line.startsWith("⚑"))).toHaveLength(2);
    for (const kept of ["queue    north", "actions  toolshed", "machine  cpu 11%", "gpu      NVIDIA"]) expect(shown.some((line) => line.startsWith(kept))).toBe(true);
  });

  test("keeps a row for each rule on a screen too short for the rest, and counts the rows the rest leaves out", () => {
    const shown = withAlertsAt(10);
    expect(shown).toHaveLength(10);
    expect(shown.slice(-summaryAt1920.length)).toEqual(summaryAt1920);
    expect(shown.at(-summaryAt1920.length - 1)).toMatch(/^\+\d+ more rows$/u);
  });
});

describe("the dashboard screen, against its pinned recording", () => {
  test("renders the pinned frame at 84x24", () => {
    const frame = printed(24, width).join("\n").concat("\n");
    expect(frame).toBe(fixture("screens/dashboard-84x24.txt"));
  });
});

const savedNames = ["third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"];

const busyBlocks = () => blocksOf(fixture("quota-axi/full.json"), () => savedNames);

const manyGpuView = (cards: number) => {
  const fixtures = view();
  if (fixtures.gpu === undefined) throw new Error("the fixture has no gpu reading");
  const gpus = valueOf(fixtures.gpu);
  const [card] = gpus.gpus;
  return { ...fixtures, gpu: ok({ ...gpus, gpus: Array.from({ length: cards }, (_, index) => ({ ...card, name: `NVIDIA A100 #${index}` })) }) };
};

describe("the dashboard with eight saved claude profiles and sixteen gpus in a standard 84x24 terminal", () => {
  const lines = () => glanceRows({ blocks: busyBlocks(), sessions: sessions(), machines: alone(manyGpuView(16)) }, width, standardRows).map(plain);

  test("keeps every live account, two flags and the machine, and sums the gpus up on one line", () => {
    const shown = lines();
    expect(shown.length).toBeLessThanOrEqual(standardRows);
    for (const header of ["● claude main", "● codex", "● opencode-go"]) expect(shown.some((line) => line.startsWith(header))).toBe(true);
    expect(shown.filter((line) => line.startsWith("⚑"))).toHaveLength(2);
    expect(shown).toContain("machine  cpu 11% · memory 5.5G of 31.3G");
    expect(shown).toContain("gpus     16 cards · busiest 9% · memory 29.2G of 256.0G");
  });

  test("keeps the gpus' memory total whole in a 30 column terminal", () => {
    const shown = glanceRows({ blocks: busyBlocks(), sessions: sessions(), machines: alone(manyGpuView(16)) }, 30, Number.POSITIVE_INFINITY).map(plain);
    expect(shown).toEqual(expect.arrayContaining(["gpus     16 cards · busiest 9%", "         memory 29.2G", "         of 256.0G"]));
  });

  test("counts every saved profile it leaves out", () => {
    const shown = lines();
    const listed = ["second", ...savedNames].filter((name) => shown.some((line) => line.startsWith(`● claude ${name} `))).length;
    const left = Number(/^\+(\d+) more claude profiles$/mu.exec(shown.join("\n"))?.[1]);
    expect(listed).toBeLessThan(1 + savedNames.length);
    expect(listed + left).toBe(1 + savedNames.length);
  });
});

const unreportedCards = [
  "NVIDIA A100 #0, [N/A], 8192, 16384, 40",
  "NVIDIA A100 #1, [N/A], 8192, 16384, 41",
  "NVIDIA A100 #2, [N/A], [N/A], 16384, 42",
].join("\n");

describe("the dashboard with three gpus that do not report every reading", () => {
  test("sums up only what every card reports", () => {
    const shown = glanceRows({ blocks: blocks(), sessions: sessions(), machines: alone(view(unreportedCards)) }, width, Number.POSITIVE_INFINITY).map(plain);
    expect(shown).toContain("gpus     3 cards");
    expect(shown.join("\n")).not.toMatch(/busiest|memory 16\.0G of 48\.0G/u);
  });
});

describe("the dashboard with more flags than the terminal holds", () => {
  test("counts the flags it leaves out as flags", () => {
    const shown = [24, 23, 22, 21, 20]
      .map((rows) => glanceRows({ blocks: blocks(), sessions: Option.some(fiveHourAheadSessionView()), machines: alone(view()) }, width, rows).map(plain).join("\n"))
      .find((text) => /^\+\d+ more/mu.test(text));
    const left = /^\+(\d+) more flags?$/mu.exec(shown ?? "");
    expect(left).not.toBeNull();
    expect((shown?.match(/^⚑/gmu)?.length ?? 0) + Number(left?.[1])).toBe(5);
  });
});

const queueLinesOf = (queues: QueuesView, columns = width): ReadonlyArray<string> => {
  return queuesSection(queues, columns).map(plain);
};

const editPueue = (queues: QueuesView, edit: (pueue: PueueView) => PueueView): QueuesView => ({
  ...queues,
  machines: queues.machines.map((machine) => ({ ...machine, pueue: Option.map(machine.pueue, (read) => (read.kind === "ok" ? ok(edit(read.value)) : read)) })),
});

describe("the dashboard says how the queues stand", () => {
  test("with each machine's counts and what holds its work back, then the actions", () => {
    const lines = queueLinesOf(fixtureQueues(["north", "south"]));
    expect(lines).toEqual([
      "queue    north · 2 running · 2 queued · 1 paused · gpu group paused",
      "         south · 2 running · 2 queued · 1 paused · gpu group paused",
      "actions  toolshed · 2 running · 1 waiting",
    ]);
    const screen = printed().join("\n");
    expect(screen).not.toMatch(/sleep 800|\/home\/example|01EXAMPLERUN/u);
  });

  test("says a machine with nothing running or queued is idle", () => {
    const idle = editPueue(fixtureQueues(), (pueue) => ({ ...pueue, running: [], queued: 0, paused: 0, groups: [] }));
    expect(queueLinesOf(idle)[0]).toBe("queue    north · idle");
  });

  test("says when the last run failed", () => {
    const failed = editPueue(fixtureQueues(), (pueue) => ({
      ...pueue,
      ended: pueue.ended.map((run, index) => (index === 0 ? { ...run, result: { kind: "exit", code: 1 } } : run)),
    }));
    expect(queueLinesOf(failed).slice(0, 2)).toEqual([
      "queue    north · 2 running · 2 queued · 1 paused · gpu group paused",
      "         last run failed",
    ]);
  });

  test("says why a machine could not be read, beside the machine it could", () => {
    const [north] = fixtureQueues().machines;
    const southDown: QueuesView = { ...fixtureQueues(), machines: [north, { name: "south", pueue: Option.some(unreachable("sh exited 255: ssh: connect to host south.example.com port 22: Connection refused")) }] };
    expect(queueLinesOf(southDown, 200)[1]).toBe("         south ✗ unreachable: sh exited 255: ssh: connect to host south.example.com port 22: Connection refused");
  });

  test("says which machine and runs it is still reading, beside the machine it has read", () => {
    const queues = fixtureQueues();
    const [north] = queues.machines;
    const reading: QueuesView = { machines: [north, { name: "south", pueue: Option.none() }], actions: { ...queues.actions, runs: Option.none() } };
    expect(queueLinesOf(reading)).toEqual([
      "queue    north · 2 running · 2 queued · 1 paused · gpu group paused",
      "         south · reading…",
      "actions  toolshed · reading…",
    ]);
  });

  test("leaves a count of none out", () => {
    const queues = fixtureQueues();
    const running = editPueue(queues, (pueue) => ({ ...pueue, queued: 0 }));
    const actions = { ...running.actions, runs: Option.some(ok([{ title: "ci", workflow: "ci", running: true }])) };
    expect(queueLinesOf({ ...running, actions })).toEqual([
      "queue    north · 2 running · 1 paused · gpu group paused",
      "actions  toolshed · 1 running",
    ]);
  });

  test("says when no actions run is queued", () => {
    const queues = fixtureQueues();
    expect(queueLinesOf({ ...queues, actions: { ...queues.actions, runs: Option.some(ok([])) } }).at(-1)).toBe("actions  toolshed · none queued");
  });

  test("wraps each reading whole in a 30 column terminal", () => {
    expect(queueLinesOf(fixtureQueues(), 30)).toEqual([
      "queue    north · 2 running",
      "         2 queued · 1 paused",
      "         gpu group paused",
      "actions  toolshed · 2 running",
      "         1 waiting",
    ]);
  });
});

const withSouth = (reading: RemoteResources["reading"], localName = "north", remoteName = "south") =>
  machinesView({ name: localName, view: view() }, [{ name: remoteName, reading }], now);

const machineRows = (machines: ReturnType<typeof withSouth>, columns = width): ReadonlyArray<string> =>
  glance(glanceRows({ blocks: blocks(), sessions: sessions(), machines: Option.some(machines) }, columns, Number.POSITIVE_INFINITY).map(plain), (line) => line);

describe("the dashboard with a second machine configured", () => {
  test("states each machine by its name, each gpu under its machine", () => {
    const rows = machineRows(withSouth(ok(southResources())));
    const north = rows.indexOf("north    cpu 11% · memory 5.5G of 31.3G");
    expect(rows.slice(north)).toEqual([
      "north    cpu 11% · memory 5.5G of 31.3G",
      "gpu      NVIDIA GeForce RTX 3080 Laptop GPU · 9% · memory 1.8G of 16.0G",
      "south    cpu 42% · memory 12.0G of 64.0G",
      "gpu      NVIDIA GeForce RTX 4090 · 63% · memory 8.0G of 24.0G",
    ]);
  });

  test("widens the label column for a name longer than it", () => {
    const rows = machineRows(withSouth(ok(southResources()), "north", "workstation-two"));
    expect(rows).toContain("north           cpu 11% · memory 5.5G of 31.3G");
    expect(rows).toContain("workstation-two cpu 42% · memory 12.0G of 64.0G");
  });

  test("shortens a name too long for a 30 column terminal and keeps both machines' readings", () => {
    const rows = machineRows(withSouth(ok(southResources()), "north", "workstation-two.example.com"), 30);
    expect(rows).toEqual(
      expect.arrayContaining(["north    cpu 11%", "         memory 5.5G of 31.3G", "worksta… cpu 42%", "         memory 12.0G of 64.0G"]),
    );
  });

  test("says the machine is unreachable and keeps the whole reason", () => {
    const reason = "sh exited 255: ssh: Could not resolve hostname south.example.com: Name or service not known";
    const rows = machineRows(withSouth({ kind: "unreachable", reason }));
    expect(rows.slice(-2)).toEqual([
      "south    ✗ unreachable: sh exited 255: ssh: Could not resolve hostname",
      "         south.example.com: Name or service not known",
    ]);
  });

  test("leaves out a report older than a minute and says how old it is", () => {
    const stale = { ...southResources(), generatedAt: DateTime.makeUnsafe("2026-10-13T20:15:16Z") };
    expect(machineRows(withSouth(ok(stale))).at(-1)).toBe("south    ! answered 3m ago, so its readings are left out");
    expect(machineRows(withSouth(ok(stale)), 30).slice(-3)).toEqual(["south    ! answered 3m ago, so", "         its readings are left", "         out"]);
  });
});
