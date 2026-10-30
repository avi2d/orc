import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";
import { TestConsole } from "effect/testing";
import { dispatchSourceLayer } from "@tui-dash/schema";
import { printDispatchFrame } from "@tui-dash/dispatch";
import { writeDispatchBacklog } from "../../lib/dispatch-fixture";
import { stripSgr } from "../../e2e/lib/print-color";

const printed = (root: string, color: boolean): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* printDispatchFrame(84, Number.POSITIVE_INFINITY, color);
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

const withPrinted = async (body: (frame: string) => void, color = false): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-dispatch-"));
  try {
    await writeDispatchBacklog(join(root, "backlog"));
    body(await printed(root, color));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("the dispatch --print frame", () => {
  test("prints the machines, the run and why each task waits instead of only the head count", async () => {
    await withPrinted((frame) => {
      expect(frame).toContain("1 of 1");
      expect(frame).toContain("task-6 orc on mac as main");
      expect(frame).toContain("waits for the next beat");
      expect(frame).toContain("waits on task-9, which the backlog does not hold");
    });
  });

  test("carries no visible text the plain frame does not carry, which itself carries no escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-dispatch-"));
    try {
      await writeDispatchBacklog(join(root, "backlog"));
      const frame = await printed(root, false);
      expect(frame).not.toContain("\u001b");
      expect(stripSgr(await printed(root, true))).toBe(frame);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
