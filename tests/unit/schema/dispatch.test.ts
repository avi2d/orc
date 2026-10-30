import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";
import {
  type DispatchReading,
  type DispatchSnapshot,
  DispatchSource,
  dispatchSourceLayer,
  dispatchView,
} from "@tui-dash/schema";
import { writeDispatchBacklog } from "../../lib/dispatch-fixture";

const readBacklog = (home: string): Promise<DispatchReading> =>
  Effect.runPromise(
    Effect.flatMap(DispatchSource, (source) => source.read).pipe(
      Effect.provide(dispatchSourceLayer.pipe(Layer.provide(BunFileSystem.layer))),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: home, ORC_HOME: home }))),
    ),
  );

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-dispatch-"));
  try {
    await writeDispatchBacklog(join(root, "backlog"));
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const snapshotOf = (reading: DispatchReading): DispatchSnapshot => reading.snapshot;

describe("the dispatcher source", () => {
  test("reads the machines, projects and every task file the dispatcher wrote", async () => {
    await withBacklog(async (root) => {
      const snapshot = snapshotOf(await readBacklog(root));
      expect(snapshot.missing).toBe(false);
      expect(snapshot.machines).toEqual({ kind: "ok", value: [{ name: "mac", slots: 1, start: ["true"] }, { name: "linux", slots: 2, start: ["true"] }] });
      expect(snapshot.projects).toEqual({
        kind: "ok",
        value: [
          { name: "orc", checkouts: { mac: "/Users/a/orc", linux: "/home/a/orc" } },
          { name: "docs", checkouts: { mac: "/Users/a/docs" } },
        ],
      });
      expect(snapshot.tasks.map((task) => task.id).toSorted()).toEqual(
        ["task-1", "task-10", "task-2", "task-3", "task-4", "task-5", "task-6", "task-7", "task-8"],
      );
    });
  });

  test("lists a broken task file as unread instead of failing the read", async () => {
    await withBacklog(async (root) => {
      await writeFile(join(root, "backlog", "new", "task-11.md"), "no frontmatter here" + String.fromCharCode(10));
      const snapshot = snapshotOf(await readBacklog(root));
      expect(snapshot.unread).toHaveLength(1);
      expect(snapshot.unread[0]).toContain("task-11.md");
    });
  });

  test("says the beat cannot place a task while a file is unread instead of naming the next beat", async () => {
    await withBacklog(async (root) => {
      await writeFile(join(root, "backlog", "new", "task-11.md"), "no frontmatter here" + String.fromCharCode(10));
      const view = dispatchView(snapshotOf(await readBacklog(root)));
      expect(view.waiting.find((row) => row.id === "task-1")?.reason).toBe("the beat cannot read the backlog");
      expect(view.waiting.find((row) => row.id === "task-2")?.reason).toBe("the beat cannot read the backlog");
    });
  });

  test("reads a missing backlog as missing instead of failing", async () => {
    const snapshot = snapshotOf(await readBacklog(join(tmpdir(), "orc-dispatch-absent-" + Date.now().toString())));
    expect(snapshot.missing).toBe(true);
    expect(snapshot.machines.kind).toBe("unreachable");
    expect(snapshot.tasks).toEqual([]);
  });
});

describe("the dispatch view", () => {
  test("counts the room from taken claims instead of every task file", async () => {
    await withBacklog(async (root) => {
      const view = dispatchView(snapshotOf(await readBacklog(root)));
      expect(view.machines).toEqual({
        kind: "ok",
        value: [
          { machine: "mac", slots: 1, busy: 1 },
          { machine: "linux", slots: 2, busy: 0 },
        ],
      });
    });
  });

  test("lists taken claims as runs with their machine and account", async () => {
    await withBacklog(async (root) => {
      const view = dispatchView(snapshotOf(await readBacklog(root)));
      expect(view.runs).toEqual([{ id: "task-6", title: "Running task", project: "orc", machine: "mac", account: "main", started: false }]);
    });
  });

  test("a pinned task on a full machine reads as unclaimed instead of forecasting room", async () => {
    await withBacklog(async (root) => {
      const view = dispatchView(snapshotOf(await readBacklog(root)));
      expect(view.waiting.find((row) => row.id === "task-7")).toEqual({ id: "task-7", title: "Full machine", project: "orc", reason: "unclaimed" });
    });
  });

  test("a blocked task waits on its missing dependency instead of the next beat", async () => {
    await withBacklog(async (root) => {
      const view = dispatchView(snapshotOf(await readBacklog(root)));
      expect(view.waiting.find((row) => row.id === "task-2")?.reason).toBe("waits on task-9, which the backlog does not hold");
      expect(view.waiting.find((row) => row.id === "task-1")?.reason).toBe("unclaimed");
    });
  });

  test("eligible tasks read as unclaimed instead of forecasting the beat", async () => {
    await withBacklog(async (root) => {
      const file = (id: string, title: string): string =>
        ["---", 'id: "' + id + '"', 'title: "' + title + '"', 'project: "orc"', "machine: null", "depends_on: []", 'created: "2026-10-27T10:00:00.000Z"', "---", "# " + title, ""].join("\n");
      await writeFile(join(root, "backlog", "new", "task-12.md"), file("task-12", "Second free task"));
      await writeFile(join(root, "backlog", "new", "task-13.md"), file("task-13", "Third free task"));
      const view = dispatchView(snapshotOf(await readBacklog(root)));
      expect(view.waiting.find((row) => row.id === "task-12")?.reason).toBe("unclaimed");
      expect(view.waiting.find((row) => row.id === "task-13")?.reason).toBe("unclaimed");
    });
  });

  test("an extensionless task file is ignored instead of listed", async () => {
    await withBacklog(async (root) => {
      await writeFile(
        join(root, "backlog", "new", "task-12"),
        ["---", 'id: "task-12"', 'title: "Extensionless task"', 'project: "orc"', "machine: null", "depends_on: []", 'created: "2026-10-27T10:00:00.000Z"', "---", "# Extensionless task", ""].join("\n"),
      );
      const view = dispatchView(snapshotOf(await readBacklog(root)));
      expect(view.waiting.some((row) => row.id === "task-12")).toBe(false);
      expect(view.unread.some((missed) => missed.includes("task-12"))).toBe(false);
    });
  });

  test("an unreadable project file is named as unread even with no new tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-dispatch-"));
    try {
      const backlog = join(root, "backlog");
      await mkdir(join(backlog, "new"), { recursive: true });
      await mkdir(join(backlog, "taken"), { recursive: true });
      await mkdir(join(backlog, "closed"), { recursive: true });
      await writeFile(
        join(backlog, "dispatch.json"),
        JSON.stringify({
          machines: [{ name: "mac", slots: 1, start: ["true"] }],
          quota: { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: "/secrets/main-token" }], floorPercent: 15 },
        }),
      );
      await writeFile(join(backlog, "projects.json"), "not json");
      await writeFile(
        join(backlog, "taken", "task-6.md"),
        ["---", 'id: "task-6"', 'title: "Running task"', 'project: "orc"', "machine: null", "depends_on: []", 'beat: "beat-1"', 'taken_for: "mac"', 'account: "main"', 'taken_at: "2026-10-27T10:01:00.000Z"', 'created: "2026-10-27T10:00:00.000Z"', "---", "# Running task", ""].join("\n"),
      );
      const view = dispatchView(snapshotOf(await readBacklog(root)));
      expect(view.runs).toHaveLength(1);
      expect(view.waiting).toEqual([]);
      expect(view.unread.some((missed) => missed.includes("projects.json"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an inherited property is not a checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-dispatch-"));
    try {
      const backlog = join(root, "backlog");
      await mkdir(join(backlog, "new"), { recursive: true });
      await mkdir(join(backlog, "taken"), { recursive: true });
      await mkdir(join(backlog, "closed"), { recursive: true });
      await writeFile(
        join(backlog, "dispatch.json"),
        JSON.stringify({
          machines: [{ name: "constructor", slots: 1, start: ["true"] }],
          quota: { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: "/secrets/main-token" }], floorPercent: 15 },
        }),
      );
      await writeFile(join(backlog, "projects.json"), JSON.stringify({ projects: [{ name: "proj", checkouts: {} }] }));
      await writeFile(
        join(backlog, "new", "task-1.md"),
        ["---", 'id: "task-1"', 'title: "First task"', 'project: "proj"', "machine: null", "depends_on: []", 'created: "2026-10-27T10:00:00.000Z"', "---", "# First task", ""].join("\n"),
      );
      const view = dispatchView(snapshotOf(await readBacklog(root)));
      expect(view.waiting.find((row) => row.id === "task-1")?.reason).toBe("the project proj has no checkout on any machine");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unknown project, machine or checkout waits on just that instead of room", async () => {
    await withBacklog(async (root) => {
      const view = dispatchView(snapshotOf(await readBacklog(root)));
      const reasons = new Map(view.waiting.map((row) => [row.id, row.reason]));
      expect(reasons.get("task-3")).toBe("the project site is not in the project list");
      expect(reasons.get("task-4")).toBe("the machine feld is not in dispatch.json");
      expect(reasons.get("task-5")).toBe("the project docs has no checkout on linux");
    });
  });

  test("leaves closed tasks out of the runs and the waiting instead of listing them", async () => {
    await withBacklog(async (root) => {
      const view = dispatchView(snapshotOf(await readBacklog(root)));
      expect(view.waiting.some((row) => row.id === "task-8" || row.id === "task-10")).toBe(false);
      expect(view.runs.some((row) => row.id === "task-8" || row.id === "task-10")).toBe(false);
    });
  });
});
