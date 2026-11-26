import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";
import { CommandRunner, configuredQuotaSourceLayer, QuotaSource } from "@avi2dg/orc-schema";
import { fixture } from "../../lib/fixtures";

const root = mkdtempSync(join(tmpdir(), "orc-dash-subquo-refused-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the configured quota source", () => {
  test("starts and reads quota-axi instead of failing when the config is refused", async () => {
    const config = join(root, "config.json");
    writeFileSync(config, "{ not json");
    const asked: Array<ReadonlyArray<string>> = [];
    const layer = configuredQuotaSourceLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          BunFileSystem.layer,
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: root, ORC_DASH_CONFIG: config })),
          Layer.succeed(CommandRunner, {
            run: (command) => {
              asked.push(command.argv);
              return Effect.succeed(fixture("quota-axi/full.json"));
            },
          }),
        ),
      ),
    );
    const reading = await Effect.runPromise(Effect.flatMap(QuotaSource, (source) => source.read(["claude"])).pipe(Effect.provide(layer)));
    expect(reading.kind).toBe("ok");
    expect(asked.some((argv) => argv[0] === "subquo")).toBe(false);
  });
});
