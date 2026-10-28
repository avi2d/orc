import { Config, Option } from "effect";

export const selector = (name: string): Config.Config<string | undefined> =>
  Config.option(Config.String(name)).pipe(
    Config.map((value) => Option.getOrUndefined(Option.filter(value, (text) => text.trim() !== ""))),
  );

export const machineNames: Config.Config<{ readonly local: string; readonly remote: string }> = Config.all({
  local: Config.String("TUI_DASH_MACHINE").pipe(Config.withDefault("local")),
  remote: Config.String("TUI_DASH_REMOTE_MACHINE").pipe(Config.withDefault("remote")),
});

export const claudeConfigDirectory: Config.Config<string> = Config.all({
  home: Config.String("HOME"),
  claudeConfig: selector("CLAUDE_CONFIG_DIR"),
}).pipe(Config.map(({ home, claudeConfig }) => claudeConfig ?? `${home}/.claude`));

// A Claude OAuth token or Keychain selector names an account no log folder is tied to, so no Claude log can stand for it.
export const claudeLogged: Config.Config<boolean> = Config.all({
  claudeToken: selector("CLAUDE_CODE_OAUTH_TOKEN"),
  claudeKeychain: selector("CLAUDE_SECURESTORAGE_CONFIG_DIR"),
}).pipe(Config.map(({ claudeToken, claudeKeychain }) => claudeToken === undefined && claudeKeychain === undefined));

const stateDirectory = (folder: string): Config.Config<string> =>
  Config.all({
    home: Config.String("HOME"),
    state: selector("XDG_STATE_HOME"),
  }).pipe(Config.map(({ home, state }) => `${state ?? `${home}/.local/state`}/tui-dash/${folder}`));

export const captureLedgerDirectory: Config.Config<string> = stateDirectory("usage");

export const taskSamplesDirectory: Config.Config<string> = stateDirectory("tasks");

export const dashboardCacheDirectory: Config.Config<string> = stateDirectory("dashboard");

export const sessionLogsCacheDirectory: Config.Config<string> = stateDirectory("session-logs");
