import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { decodeJson, HarvestLogSource, SessionLogSource } from "@tui-dash/schema";
import { harvestLogSourceLive, sessionLogSourceLive } from "@tui-dash/session-quota";
import { fixture } from "../../lib/fixtures";

const writer = join(import.meta.dir, "..", "..", "..", "packages", "session-quota", "src", "capture-bin.ts");

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tui-dash-capture-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const ledgerDirectory = () => join(home, "state", "tui-dash", "usage");

const environment = (extra: Readonly<Record<string, string>> = {}): Record<string, string> => ({
  PATH: process.env["PATH"] ?? "",
  HOME: home,
  XDG_STATE_HOME: join(home, "state"),
  XDG_CONFIG_HOME: join(home, "config"),
  ...extra,
});

interface Ran {
  readonly code: number;
  readonly stderr: string;
  readonly seconds: number;
}

const capture = async (kind: string, stdin: string | undefined, extra: Readonly<Record<string, string>> = {}): Promise<Ran> => {
  const started = performance.now();
  const child = Bun.spawn(["bun", writer, kind], { env: environment(extra), stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  if (stdin !== undefined) {
    await child.stdin.write(stdin);
    await child.stdin.end();
  }
  const code = await child.exited;
  const stderr = await new Response(child.stderr).text();
  if (stdin === undefined) await child.stdin.end();
  return { code, stderr, seconds: (performance.now() - started) / 1000 };
};

const ledgerLines = (): ReadonlyArray<string> =>
  existsSync(ledgerDirectory())
    ? readdirSync(ledgerDirectory()).flatMap((name) =>
        readFileSync(join(ledgerDirectory(), name), "utf8").split("\n").filter((line) => line !== ""),
      )
    : [];

const readBack = <A>(use: Effect.Effect<A, never, SessionLogSource | HarvestLogSource>, readerExtra: Readonly<Record<string, string>> = {}): Promise<A> =>
  Effect.runPromise(
    use.pipe(
      Effect.provide(
        Layer.merge(sessionLogSourceLive, harvestLogSourceLive).pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(environment(readerExtra)))),
        ),
      ),
    ),
  );

const sinceYesterday = () => Date.now() - 86_400_000;

describe("tui-dash-capture pi-call, run as the Pi hook runs it", () => {
  test("appends one usage-only record that the session reader counts", async () => {
    const ran = await capture("pi-call", fixture("capture/pi-message-end.json"));
    expect(ran).toMatchObject({ code: 0, stderr: "" });
    const lines = ledgerLines();
    expect(lines).toHaveLength(1);
    expect(lines.join("")).not.toContain("never hold");
    const captured = await readBack(Effect.flatMap(SessionLogSource, (source) => source.read({ pi: sinceYesterday() })));
    expect(captured.captured.calls.map((call) => [call.provider, call.tokens, call.messageAt])).toEqual([
      ["claude-bridge", { input: 3, output: 120, cacheRead: 40000, cacheWrite: 500 }, Date.parse("2026-10-17T10:00:08Z")],
    ]);
  });

  test("keeps the ledger to its owner", async () => {
    await capture("pi-call", fixture("capture/pi-message-end.json"));
    const names = readdirSync(ledgerDirectory());
    expect(statSync(ledgerDirectory()).mode & 0o777).toBe(0o700);
    expect(names.map((name) => statSync(join(ledgerDirectory(), name)).mode & 0o777)).toEqual([0o600]);
  });

  test("prunes a day file past the month when it starts a new day, and keeps last week's", async () => {
    mkdirSync(ledgerDirectory(), { recursive: true });
    const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    writeFileSync(join(ledgerDirectory(), `${day(40)}.jsonl`), "");
    writeFileSync(join(ledgerDirectory(), `${day(7)}.jsonl`), "");
    await capture("pi-call", fixture("capture/pi-message-end.json"));
    expect(readdirSync(ledgerDirectory()).toSorted()).toEqual([`${day(7)}.jsonl`, `${day(0)}.jsonl`]);
  });
});

// The fixture's input as the ledger holds it: 23 and 41 percent used, resetting at 1792245600 and 1792602000 Unix seconds.
const statuslineReading = () => ({
  schemaVersion: 1,
  kind: "claude-code-reading",
  sessionId: "cccccccc-0000-4000-8000-0000000c0de1",
  cwd: "/home/tester/notes",
  claudeHome: join(home, ".claude"),
  totalApiDurationMs: 42000,
  windows: [
    { window: "five_hour", usedPercent: 23, resetsAt: "2026-10-17T14:00:00.000Z" },
    { window: "seven_day", usedPercent: 41, resetsAt: "2026-10-21T17:00:00.000Z" },
  ],
});

describe("tui-dash-capture claude-statusline, run as the statusline runs it", () => {
  test("appends a reading once while the statusline repeats it, which the harvest reads as what is left", async () => {
    const input = fixture("capture/claude-statusline.json");
    expect(await capture("claude-statusline", input)).toMatchObject({ code: 0, stderr: "" });
    expect(await capture("claude-statusline", input)).toMatchObject({ code: 0, stderr: "" });
    expect(ledgerLines()).toHaveLength(1);
    const read = await readBack(Effect.flatMap(HarvestLogSource, (source) => source.read({ "claude-code": sinceYesterday() })));
    expect(read.captured.readings.map((reading) => [reading.windowId, reading.percentRemaining, reading.via])).toEqual([
      ["five_hour", 77, "statusline"],
      ["seven_day", 59, "statusline"],
    ]);
  });

  test("dates a reading repeated after midnight by its sighting the day before", async () => {
    mkdirSync(ledgerDirectory(), { recursive: true });
    const readAt = (at: string) => `${JSON.stringify({ ...statuslineReading(), at })}\n`;
    writeFileSync(join(ledgerDirectory(), "2026-10-16.jsonl"), readAt("2026-10-16T22:00:00.000Z"));
    writeFileSync(join(ledgerDirectory(), "2026-10-17.jsonl"), readAt("2026-10-17T00:45:00.000Z"));
    const harvest = (since: string) =>
      readBack(Effect.flatMap(HarvestLogSource, (source) => source.read({ "claude-code": Date.parse(since) })));
    expect((await harvest("2026-10-17T00:05:00Z")).captured.readings).toEqual([]);
    const evening = (await harvest("2026-10-16T21:00:00Z")).captured.readings;
    expect(evening.map((reading) => [reading.windowId, new Date(reading.observedAt).toISOString()])).toEqual([
      ["five_hour", "2026-10-16T22:00:00.000Z"],
      ["seven_day", "2026-10-16T22:00:00.000Z"],
    ]);
  });

  test("dates a repeat two days on by its first sighting behind 64 KiB of other records", async () => {
    mkdirSync(ledgerDirectory(), { recursive: true });
    const readAt = (at: string) => `${JSON.stringify({ ...statuslineReading(), at })}\n`;
    const otherCall = (at: string) =>
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "pi-call",
        at,
        sessionId: "other",
        sessionFile: null,
        cwd: "/home/tester/shop",
        provider: "claude-bridge",
        model: "claude-opus-5-5",
        messageAt: at,
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      })}\n`;
    const lateCall = otherCall("2026-10-16T23:00:00.000Z");
    const padding = lateCall.repeat(Math.ceil(65_537 / lateCall.length));
    writeFileSync(join(ledgerDirectory(), "2026-10-16.jsonl"), readAt("2026-10-16T10:00:00.000Z") + padding);
    writeFileSync(join(ledgerDirectory(), "2026-10-17.jsonl"), otherCall("2026-10-17T12:00:00.000Z"));
    writeFileSync(join(ledgerDirectory(), "2026-10-18.jsonl"), readAt("2026-10-18T00:45:00.000Z"));
    expect(padding.length).toBeGreaterThan(65_536);
    const harvest = (since: string) =>
      readBack(Effect.flatMap(HarvestLogSource, (source) => source.read({ "claude-code": Date.parse(since) })));
    expect((await harvest("2026-10-18T00:05:00Z")).captured.readings).toEqual([]);
    const all = (await harvest("2026-10-16T00:00:00Z")).captured.readings;
    expect(all.map((reading) => [reading.windowId, new Date(reading.observedAt).toISOString()])).toEqual([
      ["five_hour", "2026-10-16T10:00:00.000Z"],
      ["seven_day", "2026-10-16T10:00:00.000Z"],
    ]);
  });

  test("writes nothing when the session's last reading, in the day file before, is the same", async () => {
    mkdirSync(ledgerDirectory(), { recursive: true });
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const file = `${yesterday}.jsonl`;
    writeFileSync(join(ledgerDirectory(), file), `${JSON.stringify({ ...statuslineReading(), at: `${yesterday}T22:00:00.000Z` })}\n`);
    expect(await capture("claude-statusline", fixture("capture/claude-statusline.json"))).toMatchObject({ code: 0, stderr: "" });
    expect(readdirSync(ledgerDirectory())).toEqual([file]);
    expect(ledgerLines()).toHaveLength(1);
    const read = await readBack(Effect.flatMap(HarvestLogSource, (source) => source.read({ "claude-code": Date.now() - 3_600_000 })));
    expect(read.captured.readings).toEqual([]);
  });

  test("takes no reading while an OAuth token selects the account", async () => {
    const ran = await capture("claude-statusline", fixture("capture/claude-statusline.json"), {
      CLAUDE_CODE_OAUTH_TOKEN: "placeholder-not-a-token",
    });
    expect(ran).toMatchObject({ code: 0, stderr: "" });
    expect(ledgerLines()).toEqual([]);
  });
});

describe("tui-dash-capture claude-statusline, run from an account folder's settings as the README sets it", () => {
  const repository = join(import.meta.dir, "..", "..", "..");

  const captureAccountReading = async (folders: { readonly main: string; readonly second: string }): Promise<void> => {
    mkdirSync(join(home, "config", "tui-dash"), { recursive: true });
    writeFileSync(join(home, "config", "tui-dash", "config.json"), JSON.stringify({ accounts: folders }));
    const settings = decodeJson(Schema.Struct({ statusLine: Schema.Struct({ command: Schema.String }) }))(fixture("capture/account-settings.json"));
    if (settings.kind !== "ok") throw new Error(settings.issue);
    // The build is not part of a test run, and dist holds the same writer bundled.
    const command = settings.value.statusLine.command
      .replace("/path/to/orc", repository)
      .replace("dist/capture-bin.js", "src/capture-bin.ts");
    const child = Bun.spawn(["sh", "-c", command], {
      env: environment({ CLAUDE_CONFIG_DIR: folders.main }),
      stdin: new Blob([fixture("capture/claude-statusline.json")]),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
  };

  test("keys the reading by the account whose folder Claude Code ran under", async () => {
    const folders = { main: join(home, "accounts", "main"), second: join(home, "accounts", "second") };
    await captureAccountReading(folders);
    const read = await readBack(Effect.flatMap(HarvestLogSource, (source) => source.read({ "claude-code": sinceYesterday() })));
    expect(read.captured.readings).toEqual([]);
    expect(
      read.captured.accounts.map((account) => [account.name, account.readings.map((reading) => [reading.windowId, reading.percentRemaining, reading.credentialKey])]),
    ).toEqual([
      ["main", [["five_hour", 77, "main"], ["seven_day", 59, "main"]]],
      ["second", []],
    ]);
  });

  test("keeps the account reading while a token selects the account in the reader's environment", async () => {
    const folders = { main: join(home, "accounts", "main"), second: join(home, "accounts", "second") };
    await captureAccountReading(folders);
    const decoy = join(home, ".claude", "projects", "notes-project", "session.jsonl");
    mkdirSync(dirname(decoy), { recursive: true });
    writeFileSync(decoy, `${fixture("harvest/claude-code.jsonl")}\n`);
    const plain = await readBack(Effect.flatMap(HarvestLogSource, (source) => source.read({ "claude-code": sinceYesterday() })));
    expect(plain.files.map((file) => file.path)).toContain(decoy);
    const read = await readBack(
      Effect.flatMap(HarvestLogSource, (source) => source.read({ "claude-code": sinceYesterday() })),
      { CLAUDE_CODE_OAUTH_TOKEN: "placeholder-not-a-token" },
    );
    expect(read.captured.readings).toEqual([]);
    expect(read.files.filter((file) => file.harness === "claude-code")).toEqual([]);
    expect(
      read.captured.accounts.map((account) => [account.name, account.readings.map((reading) => [reading.windowId, reading.percentRemaining, reading.credentialKey])]),
    ).toEqual([
      ["main", [["five_hour", 77, "main"], ["seven_day", 59, "main"]]],
      ["second", []],
    ]);
  });
});

// The hook runs inside the agent's turn, so the writer always exits 0.
describe("tui-dash-capture, when it cannot capture", () => {
  test("drops input that is not JSON with one line and exit 0", async () => {
    const ran = await capture("pi-call", "not json");
    expect(ran).toMatchObject({ code: 0, stderr: "tui-dash-capture: stdin is not JSON\n" });
    expect(ledgerLines()).toEqual([]);
  });

  test("drops a kind it does not know with one line and exit 0", async () => {
    const ran = await capture("codex-call", "{}");
    expect(ran.code).toBe(0);
    expect(ran.stderr.trim().split("\n")).toEqual(["tui-dash-capture: expected one of pi-call, claude-statusline, got codex-call"]);
  });

  test("gives up on a stdin that never closes within seconds, with one line and exit 0", async () => {
    const ran = await capture("pi-call", undefined);
    expect(ran).toMatchObject({ code: 0, stderr: "tui-dash-capture: gave up after 2 seconds\n" });
    expect(ran.seconds).toBeLessThan(10);
  }, 20_000);
});
