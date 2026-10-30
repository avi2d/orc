import { describe, expect, test } from "bun:test";
import { type Command, SavedProfilesSource, savedProfilesSourceLayer, CommandRunner, CommandUnreachable } from "@tui-dash/schema";
import { ConfigProvider, Effect, Layer } from "effect";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";

const readWith = async (env: Record<string, string>) => {
  const asked: Array<Command> = [];
  const runner = Layer.succeed(CommandRunner, {
    run: (command) => {
      asked.push(command);
      return command.argv[0] === "sh" ? Effect.succeed(fixture("saved-profiles/status.json")) : Effect.fail(new CommandUnreachable({ reason: "not installed" }));
    },
  });
  const reading = await Effect.runPromise(
    Effect.flatMap(SavedProfilesSource, (source) => source.read).pipe(
      Effect.provide(savedProfilesSourceLayer.pipe(Layer.provide(Layer.merge(runner, ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))))),
    ),
  );
  return { reading, asked };
};

describe("the saved profiles source", () => {
  // The default runs no private tool, so a stranger sees no error.
  test("runs nothing and holds no profile while TUI_DASH_SAVED_PROFILES is unset or blank", async () => {
    for (const env of [{}, { TUI_DASH_SAVED_PROFILES: "  " }]) {
      const { reading, asked } = await readWith(env);
      expect(asked).toEqual([]);
      expect(valueOf(reading)).toEqual({ schema: 2, active_profile: null, profiles: [] });
    }
  });

  test("runs the configured shell line and decodes its profiles", async () => {
    const { reading, asked } = await readWith({ TUI_DASH_SAVED_PROFILES: "ssh other-box 'saved --json'" });
    expect(asked.map((command) => command.argv)).toEqual([["sh", "-c", "ssh other-box 'saved --json'"]]);
    expect(valueOf(reading).active_profile).toBe("main");
  });
});
