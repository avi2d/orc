import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { AlertSettings, configPath, readAlertSettings, readConfig, readConfigFile } from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";

const root = mkdtempSync(join(tmpdir(), "tui-dash-config-file-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

let folders = 0;

const folderWith = (files: Readonly<Record<string, string>>): string => {
  folders += 1;
  const folder = join(root, String(folders));
  mkdirSync(folder);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
  return folder;
};

const readAt = (path: string) => Effect.runPromise(readConfigFile(path).pipe(Effect.provide(BunFileSystem.layer)));

const refusalAt = (path: string) => Effect.runPromise(readConfigFile(path).pipe(Effect.flip, Effect.provide(BunFileSystem.layer)));

const pathFrom = (env: Record<string, string>) => Effect.runPromise(configPath.parse(ConfigProvider.fromEnvRecord(env)));

const configAt = (path: string) => Layer.mergeAll(BunFileSystem.layer, ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: root, TUI_DASH_CONFIG: path })));

const alertSettingsAt = (path: string) => Effect.runPromise(readAlertSettings.pipe(Effect.provide(configAt(path))));

const alertSettingsEnvAt = (config: string, settings: string) =>
  Effect.runPromise(
    readAlertSettings.pipe(
      Effect.provide(
        Layer.mergeAll(
          BunFileSystem.layer,
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: root, TUI_DASH_CONFIG: config, TUI_DASH_ALERTS_SETTINGS: settings })),
        ),
      ),
    ),
  );

// Unknown keys are refused, so a misspelt section fails loudly.
describe("the config file", () => {
  test("lives where TUI_DASH_CONFIG names, or else under the config home", async () => {
    expect(await pathFrom({ HOME: "/home/example", TUI_DASH_CONFIG: "/etc/example/config.json" })).toBe("/etc/example/config.json");
    expect(await pathFrom({ HOME: "/home/example", XDG_CONFIG_HOME: "/home/example/.cfg" })).toBe("/home/example/.cfg/tui-dash/config.json");
    expect(await pathFrom({ HOME: "/home/example", TUI_DASH_CONFIG: " " })).toBe("/home/example/.config/tui-dash/config.json");
  });

  test("is empty when neither it nor alerts.json exists", async () => {
    const path = join(folderWith({}), "config.json");
    expect(await readAt(path)).toEqual({ path, config: { panels: {} } });
  });

  test("keeps each section as written for the package that owns it", async () => {
    const path = join(folderWith({ "config.json": '{"appearance":{"tones":{"accent":"#000000"}},"panels":{"quota":{"x":1}},"layout":{"narrow":[]}}' }), "config.json");
    expect((await readAt(path)).config).toEqual({ appearance: { tones: { accent: "#000000" } }, panels: { quota: { x: 1 } }, layout: { narrow: [] } });
  });

  test("reads alerts.json beside it as panels.alerts while it does not exist", async () => {
    const folder = folderWith({ "alerts.json": '{"longTask":{"quietMinutes":30}}' });
    expect(await readAt(join(folder, "config.json"))).toEqual({ path: join(folder, "alerts.json"), config: { panels: { alerts: { longTask: { quietMinutes: 30 } } } } });
    expect((await alertSettingsAt(join(folder, "config.json"))).longTask.quietMinutes).toBe(30);
  });

  test("reads the file TUI_DASH_ALERTS_SETTINGS names while no config.json exists", async () => {
    const wanted = Schema.decodeUnknownSync(AlertSettings)(JSON.parse(fixture("alerts/settings.json")));
    const folder = folderWith({ "custom.json": fixture("alerts/settings.json") });
    const settings = await alertSettingsEnvAt(join(folder, "config.json"), join(folder, "custom.json"));
    expect(settings.longTask.quietMinutes).toBe(wanted.longTask.quietMinutes);
    expect(settings.longTask.repeatMinutes).toBe(wanted.longTask.repeatMinutes);
    expect(settings.longTask.everySeconds).toBe(30);
    expect(settings.heavyLoad.sustainedMinutes).toBe(wanted.heavyLoad.sustainedMinutes);
    expect(settings.heavyLoad.machines).toEqual(wanted.heavyLoad.machines);
  });

  test("reads the env file for panels.alerts while config.json sets none", async () => {
    const wanted = Schema.decodeUnknownSync(AlertSettings)(JSON.parse(fixture("alerts/settings.json")));
    const folder = folderWith({ "config.json": "{}", "custom.json": fixture("alerts/settings.json") });
    const settings = await alertSettingsEnvAt(join(folder, "config.json"), join(folder, "custom.json"));
    expect(settings.longTask.quietMinutes).toBe(wanted.longTask.quietMinutes);
  });

  test("prefers panels.alerts in config.json over the env file", async () => {
    const folder = folderWith({ "config.json": '{"panels":{"alerts":{"longTask":{"quietMinutes":40}}}}', "custom.json": '{"longTask":{"quietMinutes":20}}' });
    const settings = await alertSettingsEnvAt(join(folder, "config.json"), join(folder, "custom.json"));
    expect(settings.longTask.quietMinutes).toBe(40);
  });

  test("falls back to the defaults when the env file is missing, without reading alerts.json", async () => {
    const folder = folderWith({ "alerts.json": '{"longTask":{"quietMinutes":30}}' });
    const settings = await alertSettingsEnvAt(join(folder, "config.json"), join(folder, "missing.json"));
    expect(settings.longTask.quietMinutes).toBe(15);
    expect(settings.longTask.repeatMinutes).toBe(15);
    expect(settings.longTask.everySeconds).toBe(30);
    expect(settings.heavyLoad.sustainedMinutes).toBe(5);
  });

  test("leaves alerts.json unread once it exists", async () => {
    const folder = folderWith({ "config.json": "{}", "alerts.json": '{"longTask":{"quietMinutes":30}}' });
    expect((await readAt(join(folder, "config.json"))).config).toEqual({ panels: {} });
    expect((await alertSettingsAt(join(folder, "config.json"))).longTask.quietMinutes).toBe(15);
  });

  test("names its path and the issue for a key it does not know or text that is not JSON", async () => {
    const typo = join(folderWith({ "config.json": '{"panel":{}}' }), "config.json");
    expect((await refusalAt(typo)).reason).toStartWith(`the config in ${typo} is not valid: `);
    expect((await refusalAt(typo)).reason).toContain('["panel"]');
    const prose = join(folderWith({ "config.json": "panels = {}" }), "config.json");
    expect((await refusalAt(prose)).reason).toBe(`the config in ${prose} is not valid: the text is not JSON`);
  });

  test("names the alerts section and its path when the alert settings in it are not valid", async () => {
    const path = join(folderWith({ "config.json": '{"panels":{"alerts":{"longTasks":{}}}}' }), "config.json");
    const refusal = await Effect.runPromise(
      Effect.flip(readAlertSettings).pipe(
        Effect.map((error) => ("reason" in error ? error.reason : error.message)),
        Effect.provide(configAt(path)),
      ),
    );
    expect(refusal).toStartWith(`panels.alerts in ${path} is not valid: `);
  });
});

const accountsReadAt = (path: string) =>
  Effect.runPromise(
    readConfig.pipe(
      Effect.map(({ config }) => ({ kind: "read" as const, accounts: config.accounts })),
      Effect.catchTag("ConfigRefused", ({ reason }) => Effect.succeed({ kind: "refused" as const, reason })),
      Effect.provide(configAt(path)),
    ),
  );

const accountsFile = (accounts: unknown): string => join(folderWith({ "config.json": JSON.stringify({ accounts }) }), "config.json");

describe("the accounts in the config file", () => {
  test("map each account name to its own Claude config folder, in the order written", async () => {
    const accounts = { main: `${root}/.claude-accounts/main`, second: `${root}/.claude-accounts/second` };
    expect(await accountsReadAt(accountsFile(accounts))).toEqual({ kind: "read", accounts });
  });

  test("refuse two accounts that name one folder", async () => {
    const path = accountsFile({ main: "/srv/claude/one", second: "/srv/claude/one" });
    expect(await accountsReadAt(path)).toEqual({
      kind: "refused",
      reason: expect.stringContaining("accounts main and second name the one folder /srv/claude/one"),
    });
  });

  // No two accounts share a Claude folder, and none is the shared ~/.claude.
  test("refuse an account on the shared ~/.claude, however HOME ends", async () => {
    const path = accountsFile({ main: "/srv/claude/main", shared: `${root}/.claude` });
    expect(await accountsReadAt(path)).toEqual({
      kind: "refused",
      reason: `accounts.shared in ${path} names the shared Claude folder ${root}/.claude, and an account needs a Claude config folder of its own`,
    });
    const slashed = await Effect.runPromise(
      readConfig.pipe(
        Effect.flip,
        Effect.provide(Layer.mergeAll(BunFileSystem.layer, ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: `${root}/`, TUI_DASH_CONFIG: path })))),
      ),
    );
    expect("reason" in slashed ? slashed.reason : slashed.message).toContain("names the shared Claude folder");
  });

  // A second spelling of one folder would slip past the one-folder check, so every spelling but the plain one is refused.
  for (const folder of ["relative/main", "/srv/claude/main/", "/srv//claude", "/srv/./claude", "/srv/claude/../.claude", "~/.claude-accounts/main"]) {
    test(`refuse the folder ${folder}`, async () => {
      expect(await accountsReadAt(accountsFile({ main: folder }))).toEqual({
        kind: "refused",
        reason: expect.stringContaining("an absolute folder path with no trailing slash"),
      });
    });
  }

  for (const name of ["-main", ".hidden", "two words", ""]) {
    test(`refuse the account name ${JSON.stringify(name)}`, async () => {
      expect(await accountsReadAt(accountsFile({ [name]: "/srv/claude/main" }))).toEqual({
        kind: "refused",
        reason: expect.stringContaining(`account name ${JSON.stringify(name)} must start with a letter or digit`),
      });
    });
  }
});
