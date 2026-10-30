import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";
import { DispatchSource, dispatchSourceLayer, type DispatchView, dispatchView } from "@tui-dash/schema";
import { dispatchLines, dispatchSection } from "@tui-dash/dispatch";
import { plain } from "@tui-dash/ui";
import { writeDispatchBacklog } from "../../lib/dispatch-fixture";

const width = 84;

const viewOf = (home: string): Promise<DispatchView> =>
  Effect.runPromise(
    Effect.map(Effect.flatMap(DispatchSource, (source) => source.read), (reading) => dispatchView(reading.snapshot)).pipe(
      Effect.provide(dispatchSourceLayer.pipe(Layer.provide(BunFileSystem.layer))),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: home, ORC_HOME: home }))),
    ),
  );

const withView = async (body: (view: DispatchView) => void): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-dispatch-"));
  try {
    await writeDispatchBacklog(join(root, "backlog"));
    body(await viewOf(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const printed = (view: DispatchView, columns = width, rows = Number.POSITIVE_INFINITY): ReadonlyArray<string> =>
  dispatchLines(view, columns, rows).map(plain).map((line) => line.trimEnd());

const glance = (view: DispatchView): string => dispatchSection(view, width).map(plain).join("\n");

describe("the dispatch panel, against the recorded backlog", () => {
  test("counts the machines, the run and the waiting tasks instead of only the room", async () => {
    await withView((view) => {
      expect(printed(view)[0]).toContain("2 machines \u00b7 1 run \u00b7 6 waiting");
    });
  });

  test("shows each machine with its busy room instead of one shared count", async () => {
    await withView((view) => {
      const lines = printed(view);
      expect(lines.some((line) => line.includes("mac") && line.includes("1 of 1"))).toBe(true);
      expect(lines.some((line) => line.includes("linux") && line.includes("0 of 2"))).toBe(true);
    });
  });

  test("shows the run with its machine, account and title instead of the task id alone", async () => {
    await withView((view) => {
      const line = printed(view).find((row) => row.includes("task-6"));
      expect(line).toContain("orc on mac as main");
      expect(line).toContain("Running task");
    });
  });

  test("shows why each new task waits instead of only its name", async () => {
    await withView((view) => {
      const lines = printed(view);
      expect(lines.some((row) => row.includes("task-1 Free task \u00b7 waits for the next beat"))).toBe(true);
      expect(lines.some((row) => row.includes("task-2 Blocked task \u00b7 waits on task-9, which the backlog does not hold"))).toBe(true);
      expect(lines.some((row) => row.includes("task-3 Unknown project \u00b7 the project site is not in the project list"))).toBe(true);
      expect(lines.some((row) => row.includes("task-4 Unknown machine \u00b7 the machine feld is not in dispatch.json"))).toBe(true);
      expect(lines.some((row) => row.includes("task-5 No checkout \u00b7 the project docs has no checkout on linux"))).toBe(true);
      expect(lines.some((row) => row.includes("task-7 Full machine \u00b7 mac has no room"))).toBe(true);
    });
  });

  test("names the broken file instead of dropping it", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-dispatch-"));
    try {
      await writeDispatchBacklog(join(root, "backlog"));
      await writeFile(join(root, "backlog", "new", "task-11.md"), "no frontmatter here" + String.fromCharCode(10));
      expect(printed(await viewOf(root)).some((line) => line.includes("task-11.md"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("leaves closed tasks out of the panel instead of listing them", async () => {
    await withView((view) => {
      expect(printed(view).some((line) => line.includes("task-8") || line.includes("task-10"))).toBe(false);
    });
  });

  test("the glance names unread files instead of looking healthy", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-dispatch-"));
    try {
      await writeDispatchBacklog(join(root, "backlog"));
      await writeFile(join(root, "backlog", "new", "task-11.md"), "no frontmatter here" + String.fromCharCode(10));
      expect(glance(await viewOf(root))).toContain("1 unread");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the glance counts the busy room, the runs and the waiting instead of one shared count", async () => {
    await withView((view) => {
      expect(glance(view)).toContain("1 of 3 busy");
      expect(glance(view)).toContain("1 run");
      expect(glance(view)).toContain("6 waiting");
    });
  });
});
