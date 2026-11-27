import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, DateTime, Effect, Layer } from "effect";
import { TaskSamplesSource } from "@avi2dg/orc-schema";
import { tasksSourcesLive } from "@avi2dg/orc-tasks";

const root = mkdtempSync(join(tmpdir(), "orc-dash-subquo-refused-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the tasks sources", () => {
  test("starts the task samples source instead of failing when the config is refused", async () => {
    const config = join(root, "config.json");
    writeFileSync(config, "{ not json");
    const layer = tasksSourcesLive.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: root, ORC_DASH_CONFIG: config }))),
    );
    const samples = await Effect.runPromise(
      Effect.flatMap(TaskSamplesSource, (source) => source.read(DateTime.makeUnsafe("2026-01-01T00:00:00Z")))
        .pipe(Effect.provide(layer)),
    );
    expect(samples).toEqual([]);
  });
});
