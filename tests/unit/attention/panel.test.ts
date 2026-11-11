import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Effect, Fiber, Layer } from "effect";
import { TestConsole } from "effect/testing";
import { attentionModule } from "@avi2dg/orc-attention";
import { attentionSourceLayer, type Command, CommandAbsent, CommandRunner, loopTick, ReadModeReference } from "@avi2dg/orc-schema";
import { liveScreen, soloScreen } from "@avi2dg/orc-ui";
import { fixture } from "../../lib/fixtures";

type Answer = (command: Command) => Effect.Effect<string, CommandAbsent>;

const answering = (stdout: string): Answer => () => Effect.succeed(stdout);

const sourcesOf = (answer: Answer) => attentionSourceLayer.pipe(Layer.provide(Layer.succeed(CommandRunner, { run: answer })));

const printed = (answer: Answer, height = Number.POSITIVE_INFINITY): Promise<ReadonlyArray<string>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* attentionModule.print(undefined, { width: 84, height, color: false });
      return (yield* TestConsole.logLines).map(String).join("\n").split("\n");
    }).pipe(Effect.provide(Layer.merge(sourcesOf(answer), TestConsole.layer))),
  );

const inside = (row: string): string => row.slice(2, -1).trimEnd();

const open = fixture("attention/open.json");

describe("the attention panel", () => {
  test("names each item's owner and age and marks only the overdue one, rather than dropping the owner or marking every item", async () => {
    const rows = (await printed(answering(open))).map(inside);
    expect(rows).toContain("! orc-1 \u00b7 user \u00b7 10m overdue \u00b7 review-question");
    expect(rows).toContain("\u00b7 orc-9 \u00b7 decider \u00b7 4m \u00b7 review-question");
    expect(rows).toContain("\u00b7 orc-4 \u00b7 user \u00b7 2m \u00b7 review-question");
    expect(rows).toContain("  Keep the old flag?");
    expect(rows.filter((row) => row.startsWith("! "))).toHaveLength(1);
    expect(rows).toContain("3 open \u00b7 1 overdue");
  });

  test("keeps the queue's oldest-first order rather than sorting by task", async () => {
    const rows = await printed(answering(open));
    const at = (task: string) => rows.findIndex((row) => row.includes(" " + task + " \u00b7"));
    expect(at("orc-1")).toBeLessThan(at("orc-9"));
    expect(at("orc-9")).toBeLessThan(at("orc-4"));
  });

  test("reads orc attention --json alone rather than the backlog files", async () => {
    const asked: Array<ReadonlyArray<string>> = [];
    await printed((command) => {
      asked.push(command.argv);
      return Effect.succeed(open);
    });
    expect(asked).toEqual([["orc", "attention", "--json"]]);
  });

  test("says nothing needs anyone for an empty queue rather than an empty box", async () => {
    const rows = (await printed(answering(fixture("attention/empty.json")))).map(inside);
    expect(rows).toContain("nothing needs anyone");
  });

  test("says orc is missing rather than showing an empty queue", async () => {
    const rows = (await printed(() => Effect.fail(new CommandAbsent({ reason: "orc is not installed on the PATH" })))).map(inside);
    expect(rows).toContain("\u2717 unreachable: orc is not installed on the PATH");
    expect(rows).not.toContain("nothing needs anyone");
  });

  test("refuses an answer of another schema rather than reading it as a queue", async () => {
    const rows = (await printed(answering(open.replace("orc.attention.v1", "orc.attention.v2")))).map(inside);
    expect(rows.some((row) => row.startsWith("\u2717 invalid:"))).toBe(true);
  });

  test("counts the items a short box leaves out rather than cutting one in half", async () => {
    const rows = (await printed(answering(open), 7)).map(inside);
    expect(rows).toHaveLength(7);
    expect(rows).toContain("Keep the old flag?".padStart("Keep the old flag?".length + 2));
    expect(rows).toContain("+2 more items");
    expect(rows.some((row) => row.includes("orc-9"))).toBe(false);
  });

  test("paints the open items live in a terminal of its own", async () => {
    const setup = await createTestRenderer({ width: 60, height: 12 });
    const live = Effect.scoped(Effect.flatMap(attentionModule.mount(undefined), (mounted) => liveScreen(setup.renderer, soloScreen(mounted), loopTick)));
    const fiber = Effect.runFork(live.pipe(Effect.provide(sourcesOf(answering(open))), Effect.provideService(ReadModeReference, "live")));
    try {
      let frame = "";
      for (let attempt = 0; attempt < 200 && !frame.includes("orc-4"); attempt += 1) {
        await Bun.sleep(25);
        await setup.renderOnce();
        frame = setup.captureCharFrame();
      }
      expect(frame).toContain("! orc-1 \u00b7 user \u00b7 10m overdue");
      expect(frame).toContain("\u00b7 orc-4 \u00b7 user \u00b7 2m");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  });
});
