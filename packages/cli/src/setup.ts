import { type Config, Effect, type FileSystem } from "effect";
import { ConfigRefused, type DashConfig, readConfig } from "@tui-dash/schema";
import { type PanelModule, type Theme, themeOfSettings } from "@tui-dash/ui";

export interface Setup {
  readonly path: string;
  readonly config: DashConfig;
  readonly theme: Theme;
}

export const loadSetup = <R>(
  modules: ReadonlyArray<PanelModule<R>>,
): Effect.Effect<Setup, ConfigRefused | Config.ConfigError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const { path, config } = yield* readConfig;
    const ids = modules.map((module) => module.id);
    // A section no module reads, such as a misspelt panel id, would otherwise sit there unread.
    const stray = Object.keys(config.panels).find((id) => !ids.includes(id));
    if (stray !== undefined) return yield* new ConfigRefused({ reason: `panels.${stray} in ${path} is not a panel; the panels are ${ids.join(", ")}` });
    const theme = yield* themeOfSettings(config.appearance).pipe(Effect.mapError((refused) => new ConfigRefused({ reason: refused.inFile(path) })));
    return { path, config, theme };
  });
