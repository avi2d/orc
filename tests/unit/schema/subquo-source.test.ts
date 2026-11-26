import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { CommandRunner, CommandUnreachable, QuotaSource, quotaSourceLayerWithMappings } from "@avi2dg/orc-schema";
import { fixture } from "../../lib/fixtures";

const snapshotAt = (at: number): string => JSON.stringify({
  version: "subquo.v1",
  writtenAt: new Date(at).toISOString(),
  accounts: [{
    id: "main",
    provider: "claude",
    observation: {
      status: "fresh",
      observedAt: new Date(at).toISOString(),
      validUntil: new Date(at + 120_000).toISOString(),
      source: "provider",
      windows: [{ id: "five-hour", scope: "all", percentLeft: 62, resetsAt: new Date(at + 86_400_000).toISOString() }],
    },
  }],
});

const read = (subquoId: string, quotaAvailable: boolean) => {
  const asked: Array<ReadonlyArray<string>> = [];
  const layer = quotaSourceLayerWithMappings(Effect.succeed([{ provider: "claude", accountKey: "default", subquoId }] as const)).pipe(
    Layer.provide(Layer.succeed(CommandRunner, {
      run: (command) => {
        asked.push(command.argv);
        if (command.argv[0] === "subquo") return Effect.sync(() => snapshotAt(Date.now()));
        return quotaAvailable
          ? Effect.succeed(fixture("quota-axi/full.json"))
          : Effect.fail(new CommandUnreachable({ reason: "quota-axi unavailable" }));
      },
    })),
  );
  const reading = Effect.runSync(Effect.flatMap(QuotaSource, (source) => source.read(["claude"])).pipe(Effect.provide(layer)));
  return { reading, asked };
};

const claudeSession = (result: ReturnType<typeof read>): number | undefined => {
  if (result.reading.kind !== "ok") return undefined;
  const entry = result.reading.value.providers.find((item) => item.provider === "claude" && !("kind" in item));
  if (entry === undefined || "kind" in entry) return undefined;
  const window = entry.windows.find((item) => item.id === "five_hour");
  return window !== undefined && "percentRemaining" in window ? window.percentRemaining : undefined;
};

describe("the quota source with subquo mappings", () => {
  test("runs subquo and uses the mapped reading instead of quota-axi's value", () => {
    const result = read("main", true);
    expect(result.asked).toContainEqual(["subquo", "read", "--json"]);
    expect(claudeSession(result)).toBe(62);
  });

  test("keeps quota-axi instead of another account's subquo reading when the mapped ID is missing", () => {
    expect(claudeSession(read("missing", true))).toBe(98);
  });

  test("keeps a mapped subquo account visible when quota-axi cannot run", () => {
    expect(claudeSession(read("main", false))).toBe(62);
  });
});
