import { describe, expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Effect, Option } from "effect";
import { decodePueue, mapOutcome, ok, pueueView, type QueuesView, unreachable } from "@tui-dash/schema";
import { queueLines } from "@tui-dash/queues";
import { blockDocument, type Block, frameText, lineWidth, plain } from "@tui-dash/ui";
import { fixture } from "../../lib/fixtures";
import { fixtureQueues, queuesNow } from "../../lib/queues-fixture";

const width = 84;

const printed = (view: QueuesView = fixtureQueues(), columns = width, rows = Number.POSITIVE_INFINITY): ReadonlyArray<string> =>
  queueLines(view, columns, rows, queuesNow).map(plain);

const panelOf = (lines: ReadonlyArray<string>, title: string): ReadonlyArray<string> => {
  const start = lines.findIndex((line) => line.startsWith(`╭─ ${title} `));
  const end = lines.findIndex((line, index) => index > start && line.startsWith("╰"));
  if (start === -1) throw new Error(`no ${title} panel`);
  return lines.slice(start + 1, end).map((line) => line.slice(2, -2).trimEnd());
};

const divide = String.fromCharCode(10);

const normalize = (frame: string): string =>
  frame
    .split(divide)
    .map((row) => row.trimEnd())
    .join(divide)
    .trimEnd();

const rendered = async (rows: Block): Promise<string> => {
  const setup = await createTestRenderer({ width, height: rows.length + 1 });
  setup.renderer.root.add(new TextRenderable(setup.renderer, { content: blockDocument(rows) }));
  await setup.renderOnce();
  const frame = normalize(setup.captureCharFrame());
  await setup.dispose();
  return frame;
};

describe("the pueue panel, against the recorded status", () => {
  const north = () => panelOf(printed(), "pueue north");

  test("counts the running, queued and paused tasks and the ended and failed history", () => {
    expect(north().slice(0, 2)).toEqual(["2 running · 2 queued · 1 paused", "history: 6 ended · 4 failed"]);
  });

  test("lists the running runs first, then the ended ones newest first, each with its project, start, time and outcome", () => {
    const rows = north().slice(3);
    expect(rows.map((row) => /^. (\S+) +(\S+ ago) +(\S+) {2}(.*)$/u.exec(row)?.slice(1))).toEqual([
      ["unknown", "11m ago", "11m", "sleep 800"],
      ["website", "11m ago", "11m", "sleep 1000"],
      ["website", "11m ago", "0s", "echo queued work"],
      ["website", "11m ago", "17s", "killed sleep 900"],
      ["~", "11m ago", "0s", "dep failed echo after the failure"],
      ["shop", "11m ago", "0s", "exit 1 bun run test"],
      ["~", "11m ago", "0s", "true"],
      ["my-example", "11m ago", "0s", "exit 3 exit 3"],
    ]);
    expect(rows.map((row) => row[0])).toEqual(["▶", "▶", "✓", "✗", "✗", "✗", "✓", "✗"]);
  });

  test("keeps every column under its head", () => {
    const [head = "", ...rows] = north().slice(2);
    const tookEnd = head.indexOf("took") + "took".length;
    for (const row of rows) expect(row.slice(0, tookEnd)).toMatch(/ \d+[sm]$/u);
    for (const row of rows) expect(row.indexOf("11m ago")).toBe(head.indexOf("started"));
    expect(rows[2]?.indexOf("echo")).toBe(head.indexOf("command"));
  });
});

describe("the pueue groups panel, against the recorded status", () => {
  test("lists each machine's groups with their state and limit", () => {
    expect(panelOf(printed(fixtureQueues(["north", "south"])), "pueue groups")).toEqual([
      "north default running, limit 1 · gpu paused, limit 1 · tests running, limit 2",
      "south default running, limit 1 · gpu paused, limit 1 · tests running, limit 2",
    ]);
    expect(panelOf(printed(), "pueue north").join(" ")).not.toContain("limit");
  });

  // A group holds Reset while pueue reset runs.
  test("says a group is resetting, with its limit", () => {
    const view = fixtureQueues();
    const [north] = view.machines;
    const resetting = Option.map(north.pueue, (read) =>
      read.kind === "ok" ? ok({ ...read.value, groups: [{ name: "gpu", status: "Reset" as const, parallel: 3 }] }) : read,
    );
    expect(panelOf(printed({ ...view, machines: [{ ...north, pueue: resetting }] }), "pueue groups")).toEqual(["north gpu resetting, limit 3"]);
  });

  for (const [status, words] of [["Running", "running,"], ["Paused", "paused,"], ["Reset", "resetting,"]] as const) {
    // pueue accepts any group name.
    test(`keeps a ${words.slice(0, -1)} group's state and limit whole beside a name too long for a 30 column terminal`, () => {
      const view = fixtureQueues();
      const [north] = view.machines;
      const long = Option.map(north.pueue, (read) =>
        read.kind === "ok" ? ok({ ...read.value, groups: [{ name: "integration-tests-ci-nightly", status, parallel: 2 }] }) : read,
      );
      expect(panelOf(printed({ ...view, machines: [{ ...north, pueue: long }] }, 30), "pueue groups")).toEqual([
        "north integration-tests-c…",
        `      ${words} limit 2`,
      ]);
    });
  }

  test("wraps a group too wide for a 30 column terminal onto its own lines, keeping its limit", () => {
    expect(panelOf(printed(fixtureQueues(), 30), "pueue groups")).toEqual([
      "north default running,",
      "      limit 1",
      "      gpu paused, limit 1",
      "      tests running,",
      "      limit 2",
    ]);
  });
});

describe("the actions panel, against the recorded runs", () => {
  test("counts the running and waiting runs and lists them newest first", () => {
    expect(panelOf(printed(), "actions · toolshed")).toEqual([
      "2 running · 1 waiting",
      "▷ ci · fix(website): keep the footer below the fold",
      "▶ ci · feat(shop): list the orders a customer placed this week",
      "▶ mutation · build(deps): take the newest test runner",
    ]);
  });

  test("prints every run when the frame has no last row", () => {
    const view = fixtureQueues();
    const many = Array.from({ length: 20 }, (_, index) => ({ title: `run ${index}`, workflow: "ci", running: index < 5 }));
    const rows = panelOf(printed({ ...view, actions: { ...view.actions, runs: Option.some(ok(many)) } }), "actions · toolshed");
    expect(rows).toHaveLength(21);
    expect(rows.at(-1)).toBe("▷ ci · run 19");
  });

  test("says when nothing is queued", () => {
    const view = fixtureQueues();
    expect(panelOf(printed({ ...view, actions: { ...view.actions, runs: Option.some(ok([])) } }), "actions · toolshed")).toEqual(["none queued"]);
  });

  test("says why the runs could not be read", () => {
    const view = fixtureQueues();
    const failed = { ...view, actions: { ...view.actions, runs: Option.some(unreachable("gh exited 4: authentication required")) } };
    expect(panelOf(printed(failed), "actions · toolshed")).toEqual(["✗ unreachable: gh exited 4: authentication required"]);
  });
});

describe("a machine whose pueue cannot be read", () => {
  // An ssh failure is the remote command exiting 255 with ssh's own reason.
  test("says why in its own panel and keeps the other machine's", () => {
    const view = fixtureQueues(["north", "south"]);
    const [north, south] = view.machines;
    const reason = "sh exited 255: ssh: connect to host south.example.com port 22: Connection refused";
    const lines = printed({ ...view, machines: [north, { ...south, pueue: Option.some(unreachable(reason)) }] });
    expect(panelOf(lines, "pueue south").join(" ")).toBe(`✗ unreachable: ${reason}`);
    expect(panelOf(lines, "pueue north")[0]).toBe("2 running · 2 queued · 1 paused");
    expect(panelOf(lines, "pueue groups")[1]).toStartWith("south ✗ unreachable: sh exited 255");
  });
});

describe("a source still reading", () => {
  test("says so in its own panels and keeps the sources already read", () => {
    const view = fixtureQueues(["north", "south"]);
    const [north, south] = view.machines;
    const lines = printed({ machines: [north, { ...south, pueue: Option.none() }], actions: { ...view.actions, runs: Option.none() } });
    expect(panelOf(lines, "pueue south")).toEqual(["reading…"]);
    expect(panelOf(lines, "pueue groups")[1]).toBe("south reading…");
    expect(panelOf(lines, "actions · toolshed")).toEqual(["reading…"]);
    expect(panelOf(lines, "pueue north")[0]).toBe("2 running · 2 queued · 1 paused");
  });
});

const listed = (panel: ReadonlyArray<string>): number => {
  const rows = panel.filter((row) => /^[▶✓✗▷] /u.test(row)).length;
  const more = Number(/^\+(\d+) more$/u.exec(panel.find((row) => row.startsWith("+")) ?? "")?.[1] ?? 0);
  return rows + more;
};

describe("the queues in a terminal shorter than every run", () => {
  for (const rows of [30, 24, 20, 18]) {
    test(`fit ${rows} rows and count every run they leave out`, () => {
      const lines = printed(fixtureQueues(["north", "south"]), width, rows);
      expect(lines.length).toBeLessThanOrEqual(rows);
      expect(listed(panelOf(lines, "pueue north"))).toBe(8);
      expect(listed(panelOf(lines, "pueue south"))).toBe(8);
      expect(listed(panelOf(lines, "actions · toolshed"))).toBe(3);
    });
  }

  test("keep each machine's counts when no row is left for a list", () => {
    const lines = printed(fixtureQueues(["north", "south"]), width, 15);
    expect(lines).toHaveLength(15);
    for (const title of ["pueue north", "pueue south"]) {
      expect(panelOf(lines, title).slice(0, 2)).toEqual(["2 running · 2 queued · 1 paused", "history: 6 ended · 4 failed"]);
    }
  });

  test("give the two machines the same rows", () => {
    const lines = printed(fixtureQueues(["north", "south"]), width, 24);
    expect(panelOf(lines, "pueue north")).toEqual(panelOf(lines, "pueue south"));
  });
});

describe("the queues at the live panel's 30 column minimum", () => {
  const narrow = () => printed(fixtureQueues(), 30);

  test("keep every row inside the panel", () => {
    for (const line of queueLines(fixtureQueues(), 30, Number.POSITIVE_INFINITY, queuesNow)) expect(lineWidth(line)).toBe(30);
  });

  test("keep each run's start and time, and move its command to a line of its own", () => {
    const rows = panelOf(narrow(), "pueue north");
    expect(rows).toContain("  project    started  took");
    expect(rows.slice(rows.indexOf("▶ unknown    11m ago   11m"), rows.indexOf("▶ unknown    11m ago   11m") + 2)).toEqual([
      "▶ unknown    11m ago   11m",
      "  sleep 800",
    ]);
    expect(rows.slice(rows.indexOf("✗ website    11m ago   17s"), rows.indexOf("✗ website    11m ago   17s") + 2)).toEqual([
      "✗ website    11m ago   17s",
      "  killed sleep 900",
    ]);
    expect(rows).toContain("  dep failed echo after t…");
  });

  test("count every run they leave out of a short terminal", () => {
    const lines = printed(fixtureQueues(), 30, 30);
    expect(lines.length).toBeLessThanOrEqual(30);
    expect(listed(panelOf(lines, "pueue north"))).toBe(8);
  });
});

describe("a run that failed to spawn", () => {
  const spawned = (): QueuesView => {
    const status = fixture("pueue/status.json").replace('"result": "Success"', '"result": { "FailedToSpawn": "No such file or directory (os error 2)" }');
    return { ...fixtureQueues(), machines: [{ name: "north", pueue: Option.some(mapOutcome(decodePueue(status), pueueView)) }] };
  };

  // pueue's TaskResult::FailedToSpawn carries the spawn error's text.
  test("says why in full and keeps its command in a terminal wide enough for both", () => {
    expect(panelOf(printed(spawned(), 120), "pueue north")).toContain("✗ ~           11m ago    0s  spawn failed: No such file or directory (os error 2) true");
  });

  test("cuts the spawn error rather than the command in a standard terminal", () => {
    expect(panelOf(printed(spawned()), "pueue north")).toContain("✗ ~           11m ago    0s  spawn failed: No such file or directory (os e… true");
  });

  for (const columns of [30, 36, 40, 44, 48, 52, 60]) {
    test(`keeps its command and every failure's command at ${columns} columns`, () => {
      const rows = panelOf(printed(spawned(), columns), "pueue north");
      expect(rows.find((row) => row.includes("spawn failed"))).toMatch(/ true$/u);
      for (const words of ["killed", "dep failed", "exit 1", "exit 3"]) {
        expect(rows.find((row) => row.includes(words))).toMatch(new RegExp(`${words} \\S`, "u"));
      }
    });
  }
});

describe("the queues, against the pinned output", () => {
  test("renders the pinned frame through OpenTUI and the print path alike", async () => {
    const rows = queueLines(fixtureQueues(), width, Number.POSITIVE_INFINITY, queuesNow);
    const pinned = normalize(fixture("screens/queues-84x22.txt"));
    expect(await rendered(rows)).toBe(pinned);
    expect(await Effect.runPromise(frameText(blockDocument(rows), width, rows.length + 1))).toBe(pinned);
  });
});
