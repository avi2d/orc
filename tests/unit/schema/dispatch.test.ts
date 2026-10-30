import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  test("a task pinned to a full machine waits on room, not on the machine with room", async () => {
    await withBacklog(async (root) => {
      const view = dispatchView(snapshotOf(await readBacklog(root)));
      expect(view.waiting.find((row) => row.id === "task-7")).toEqual({ id: "task-7", title: "Full machine", project: "orc", reason: "mac has no room" });
    });
  });

  test("a blocked task waits on its missing dependency instead of the next beat", async () => {
    await withBacklog(async (root) => {
      const view = dispatchView(snapshotOf(await readBacklog(root)));
      expect(view.waiting.find((row) => row.id === "task-2")?.reason).toBe("waits on task-9, which the backlog does not hold");
      expect(view.waiting.find((row) => row.id === "task-1")?.reason).toBe("waits for the next beat");
    });
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
