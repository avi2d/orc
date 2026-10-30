import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";
import { TestConsole } from "effect/testing";
import { dispatchSourceLayer } from "@tui-dash/schema";
import { mountDispatch } from "@tui-dash/dispatch";
import { printSolo } from "@tui-dash/ui";
import { writeDispatchBacklog } from "../../lib/dispatch-fixture";
import { stripSgr } from "../../e2e/lib/print-color";

const printed = (root: string, height: number, color: boolean): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* printSolo(mountDispatch, { width: 84, height, color });
      return (yield* TestConsole.logLines).map(String).join("\n");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          dispatchSourceLayer.pipe(
            Layer.provide(BunFileSystem.layer),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: root, ORC_HOME: root }))),
          ),
          TestConsole.layer,
        ),
      ),
    ),
  );

const withPrinted = async (body: (frame: string) => void, color = false, height = Number.POSITIVE_INFINITY): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-dispatch-"));
  try {
    await writeDispatchBacklog(join(root, "backlog"));
    body(await printed(root, height, color));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("the dispatch --print frame", () => {
  test("prints the machines, the run and why each task waits instead of only the head count", async () => {
    await withPrinted((frame) => {
      expect(frame).toContain("1 of 1");
      expect(frame).toContain("task-6 orc on mac as main");
      expect(frame).toContain("task-1 Free task \u00b7 unclaimed");
      expect(frame).toContain("waits on task-9, which the backlog does not hold");
    });
  });

  test("fits a one-row frame instead of overflowing the border", async () => {
    await withPrinted((frame) => {
      expect(frame.split("\n")).toHaveLength(1);
    }, false, 1);
  });

  test("carries no visible text the plain frame does not carry, which itself carries no escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-dispatch-"));
    try {
      await writeDispatchBacklog(join(root, "backlog"));
      const frame = await printed(root, Number.POSITIVE_INFINITY, false);
      expect(frame).not.toContain("\u001b");
      expect(stripSgr(await printed(root, Number.POSITIVE_INFINITY, true))).toBe(frame);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
