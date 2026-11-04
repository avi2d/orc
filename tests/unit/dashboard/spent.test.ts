import { expect, test } from "bun:test";
import { Effect, FileSystem, type Layer } from "effect";
import { spentOn } from "../../lib/spent";

const sleepsAfterAFailedOpen = (fileSystem: Layer.Layer<FileSystem.FileSystem>) =>
  Effect.provide(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.flip(Effect.scoped(fs.open("/nonexistent/spent-on")));
      yield* Effect.sleep("2 seconds");
    }),
    fileSystem,
  );

test("a failed open leaves the clock free to reach a later sleep, not held until the test times out", async () => {
  expect((await spentOn(sleepsAfterAFailedOpen)).waitedMillis).toBe(2000);
});
