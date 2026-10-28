import { Config, Data, Effect, FileSystem } from "effect";
import { type AlertSettings, decodeAlertSettings } from "../contract/alerts";
import { type ClaudeAccount, claudeAccountsOf, type DashConfig, decodeDashConfig, emptyConfig, parsedJson } from "../contract/config";
import { type Decoded, flatMapDecoded } from "../decode";
import { selector } from "./environment";

export class ConfigRefused extends Data.TaggedError("ConfigRefused")<{ readonly reason: string }> {}

export const configPath: Config.Config<string> = Config.all({
  home: Config.String("HOME"),
  configHome: selector("XDG_CONFIG_HOME"),
  config: selector("TUI_DASH_CONFIG"),
}).pipe(Config.map(({ home, configHome, config }) => config ?? `${configHome ?? `${home}/.config`}/tui-dash/config.json`));

const besideConfig = (path: string, name: string): string => `${path.slice(0, path.lastIndexOf("/") + 1)}${name}`;

const fileText = (path: string): Effect.Effect<string | undefined, ConfigRefused, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const refused = (reason: string) => new ConfigRefused({ reason: `${path} ${reason}` });
    const present = yield* fs.exists(path).pipe(Effect.mapError((error) => refused(`cannot be checked: ${error.message}`)));
    if (!present) return undefined;
    return yield* fs.readFileString(path).pipe(Effect.mapError((error) => refused(`cannot be read: ${error.message}`)));
  });

export const decodeConfigText = (text: string): Decoded<DashConfig> => flatMapDecoded(parsedJson(text), decodeDashConfig);

// The alert settings had a file of their own before the config, and it still stands for panels.alerts while no config.json exists.
const legacyConfigOf = (text: string): Decoded<DashConfig> => flatMapDecoded(parsedJson(text), (alerts) => decodeDashConfig({ panels: { alerts } }));

export interface ConfigFile {
  readonly path: string;
  readonly config: DashConfig;
}

const namedAlerts = (from: string): Effect.Effect<AlertSettings | undefined, ConfigRefused, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const text = yield* fileText(from);
    if (text === undefined) return undefined;
    const settings = flatMapDecoded(parsedJson(text), decodeAlertSettings);
    return settings.kind === "ok" ? settings.value : yield* new ConfigRefused({ reason: `the alert settings in ${from} are not valid: ${settings.issue}` });
  });

export const readConfigFile = (path: string, alertsSettings?: string): Effect.Effect<ConfigFile, ConfigRefused, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const refused = (from: string, issue: string) => new ConfigRefused({ reason: `the config in ${from} is not valid: ${issue}` });
    const text = yield* fileText(path);
    if (text !== undefined) {
      const config = decodeConfigText(text);
      if (config.kind !== "ok") return yield* refused(path, config.issue);
      if (config.value.panels["alerts"] !== undefined || alertsSettings === undefined) return { path, config: config.value };
      const env = yield* namedAlerts(alertsSettings);
      if (env === undefined) return { path, config: config.value };
      return { path, config: { ...config.value, panels: { ...config.value.panels, alerts: env } } };
    }
    if (alertsSettings !== undefined) {
      const env = yield* namedAlerts(alertsSettings);
      if (env !== undefined) return { path: alertsSettings, config: { panels: { alerts: env } } };
      return { path, config: emptyConfig };
    }
    const legacyPath = besideConfig(path, "alerts.json");
    const legacy = yield* fileText(legacyPath);
    if (legacy === undefined) return { path, config: emptyConfig };
    const config = legacyConfigOf(legacy);
    return config.kind === "ok" ? { path: legacyPath, config: config.value } : yield* refused(legacyPath, config.issue);
  });

const sharedClaudeFolder = (home: string): string => `${home.replace(/\/+$/u, "")}/.claude`;

// Claude Code outside every account refreshes the shared folder's login, so an account on it would give that login two refreshers.
export const readConfig: Effect.Effect<ConfigFile, ConfigRefused | Config.ConfigError, FileSystem.FileSystem> = Effect.gen(function* () {
  const path = yield* configPath;
  const home = yield* Config.String("HOME");
  const alertsSettings = yield* selector("TUI_DASH_ALERTS_SETTINGS");
  const file = yield* readConfigFile(path, alertsSettings);
  const shared = claudeAccountsOf(file.config).find((account) => account.folder === sharedClaudeFolder(home));
  if (shared === undefined) return file;
  return yield* new ConfigRefused({
    reason: `accounts.${shared.name} in ${file.path} names the shared Claude folder ${shared.folder}, and an account needs a Claude config folder of its own`,
  });
});

export const readClaudeAccounts: Effect.Effect<ReadonlyArray<ClaudeAccount>, ConfigRefused | Config.ConfigError, FileSystem.FileSystem> = Effect.map(
  readConfig,
  ({ config }) => claudeAccountsOf(config),
);

export const readAlertSettings: Effect.Effect<AlertSettings, ConfigRefused | Config.ConfigError, FileSystem.FileSystem> = Effect.gen(function* () {
  const { path, config } = yield* readConfig;
  const settings = decodeAlertSettings(config.panels["alerts"]);
  return settings.kind === "ok" ? settings.value : yield* new ConfigRefused({ reason: `panels.alerts in ${path} is not valid: ${settings.issue}` });
});
