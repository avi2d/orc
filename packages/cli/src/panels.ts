import { BunFileSystem } from "@effect/platform-bun";
import { type Config, Console, Effect, Option } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { printDashboard, runDashboard } from "@tui-dash/dashboard";
import type { ConfigRefused } from "@tui-dash/schema";
import { Appearance, type PanelError, printFrameOf, type PrintFrame } from "@tui-dash/ui";
import { withModules } from "./live/modules";
import { type ModuleSources, modules } from "./modules";
import { loadSetup, type Setup } from "./setup";

const positive = (count: number): boolean => count > 0;

const countRefused = (unit: string) => () => `a whole number of ${unit} from 1 up`;

export const frameFlags = {
  print: Flag.Boolean("print").pipe(Flag.withDescription("Print one frame and exit instead of running live"), Flag.withDefault(false)),
  color: Flag.Boolean("color").pipe(Flag.withDescription("Colour the printed frame with ANSI escapes"), Flag.withDefault(false)),
  width: Flag.Int("width").pipe(Flag.withDescription("Width of the printed frame in columns"), Flag.filter(positive, countRefused("columns")), Flag.optional),
  height: Flag.Int("height").pipe(Flag.withDescription("Height of the printed frame in rows"), Flag.filter(positive, countRefused("rows")), Flag.optional),
};

interface FrameChoice {
  readonly print: boolean;
  readonly color: boolean;
  readonly width: Option.Option<number>;
  readonly height: Option.Option<number>;
}

const refusedForUser = <A, R>(effect: Effect.Effect<A, PanelError | ConfigRefused, R>, path?: string): Effect.Effect<A, CliError.UserError | Config.ConfigError, R> =>
  Effect.catchTags(effect, {
    SettingsRefused: (refused) => Effect.fail(new CliError.UserError({ cause: refused.inFile(path) })),
    ConfigRefused: ({ reason }) => Effect.fail(new CliError.UserError({ cause: reason })),
  });

// Live and print differ in how every source reads, so the whole run is chosen up front.
const shown = (choice: FrameChoice, run: (setup: Setup) => Effect.Effect<void, PanelError | ConfigRefused, ModuleSources>, print: (setup: Setup, frame: PrintFrame) => Effect.Effect<void, PanelError | ConfigRefused, ModuleSources>) =>
  Effect.gen(function* () {
    if (choice.color && !choice.print) return yield* new CliError.UserError({ cause: "--color colours a printed frame, so pass --print with it" });
    const setup = yield* refusedForUser(loadSetup(modules).pipe(Effect.provide(BunFileSystem.layer)));
    const frame = printFrameOf(Option.getOrUndefined(choice.width), Option.getOrUndefined(choice.height), choice.color);
    const chosen = choice.print ? withModules("print")(print(setup, frame)) : withModules("live")(run(setup));
    yield* refusedForUser(chosen, setup.path).pipe(Effect.provideService(Appearance, setup.theme));
  });

export const dashboardHandler = (choice: FrameChoice): Effect.Effect<void, CliError.UserError | Config.ConfigError> =>
  shown(
    choice,
    ({ config }) => runDashboard(modules, config),
    ({ config }, frame) => printDashboard(modules, config, frame),
  );

const panelIds = modules.map((module) => module.id);

const listed = Console.log(modules.map((module) => `${module.id.padEnd(Math.max(...panelIds.map((id) => id.length)) + 2)}${module.about}`).join("\n"));

export const panel = Command.make(
  "panel",
  {
    ...frameFlags,
    list: Flag.Boolean("list").pipe(Flag.withDescription("List every panel with what it shows"), Flag.withDefault(false)),
    id: Argument.Literals("panel", panelIds).pipe(Argument.withDescription(`The panel to open, one of ${panelIds.join(", ")}`), Argument.optional),
  },
  ({ list, id, ...choice }) =>
    Effect.gen(function* () {
      if (list) return yield* listed;
      const chosen = modules.find((module) => Option.contains(id, module.id));
      if (chosen === undefined) return yield* new CliError.UserError({ cause: `name a panel to open, one of ${panelIds.join(", ")}, or list them with --list` });
      yield* shown(
        choice,
        ({ config }) => chosen.run(config.panels[chosen.id]),
        ({ config }, frame) => chosen.print(config.panels[chosen.id], frame),
      );
    }),
).pipe(Command.withDescription("Open one panel on its own, live or as one printed frame"));
