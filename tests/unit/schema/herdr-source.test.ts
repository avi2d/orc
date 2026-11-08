import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { CommandAbsent, CommandRunner, CommandUnreachable, HerdrSource, herdrSourceLayer } from "@avi2dg/orc-schema";
import { fixture } from "../../lib/fixtures";

const readAnswering = (answer: Effect.Effect<string, CommandUnreachable | CommandAbsent>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const source = yield* HerdrSource;
      const { capturedAt: _, ...outcome } = yield* source.read;
      return outcome;
    }).pipe(Effect.provide(herdrSourceLayer), Effect.provideService(CommandRunner, { run: () => answer })),
  );

describe("the herdr source", () => {
  test("reads no panes where herdr is not installed instead of a failed read", async () => {
    const absent = new CommandAbsent({ reason: "herdr is not installed on the PATH" });
    expect(await readAnswering(Effect.fail(absent))).toEqual({ kind: "ok", value: [] });
  });

  test("reports an installed herdr that does not answer as unreachable instead of as no panes", async () => {
    const refused = new CommandUnreachable({ reason: "herdr exited 1: no server running" });
    expect(await readAnswering(Effect.fail(refused))).toEqual({ kind: "unreachable", reason: "herdr exited 1: no server running" });
  });

  test("reads the panes an installed herdr lists", async () => {
    const reading = await readAnswering(Effect.succeed(fixture("session-logs/herdr-agents.json")));
    expect(reading.kind === "ok" && reading.value.length > 0).toBe(true);
  });
});
