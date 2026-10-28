import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Layer } from "effect";
import {
  decodeHerdrPanes,
  decodeLinuxHarnessProcesses,
  decodeMacHarnessProcesses,
  type LogRecord,
  logRecords,
  type SessionLogs,
  SessionLogSource,
} from "@tui-dash/schema";
import { sessionLogSourceLive } from "@tui-dash/session-quota";
import { fixture } from "../../lib/fixtures";
import { fixtureHomeDirectory } from "../../lib/session-fixture";
import { issueOf, valueOf } from "../../lib/outcomes";

const everything = { pi: 0, "claude-code": 0, codex: 0 };

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tui-dash-sessions-"));
  cpSync(fixtureHomeDirectory, home, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const withSource = <A>(
  use: (read: (since: typeof everything) => Effect.Effect<SessionLogs>) => Effect.Effect<A>,
  env: Readonly<Record<string, string>> = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const source = yield* SessionLogSource;
      return yield* use(source.read);
    }).pipe(
      Effect.provide(sessionLogSourceLive.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: home, ...env }))))),
    ),
  );

const shopFile = () =>
  join(home, ".pi/agent/sessions/--home-tester-.treehouse-shop-a1b2c3-1-shop--/2026-10-13T17-00-00-000Z_aaaaaaaa-0000-4000-8000-00000000a001.jsonl");

const callLine = (timestamp: string) =>
  JSON.stringify({
    type: "message",
    timestamp,
    message: { role: "assistant", provider: "opencode-go", model: "m", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
  });

const recordsIn = (logs: SessionLogs, path: string) => logs.files.find((file) => file.path === path)?.records ?? [];

describe("the session log source, reading a copy of the fixture home through the Bun file system", () => {
  test("finds the eight fixture logs under HOME and decodes each the way logRecords does", async () => {
    const logs = await withSource((read) => read(everything));
    expect(logs.home).toBe(home);
    expect(logs.files).toHaveLength(8);
    const shop = recordsIn(logs, shopFile());
    expect(shop).toEqual(logRecords("pi", readFileSync(shopFile(), "utf8")));
    expect(shop).toHaveLength(5);
  });

  test("reads Codex and Claude Code logs from CODEX_HOME and CLAUDE_CONFIG_DIR, and none from HOME's", async () => {
    cpSync(join(home, ".codex"), join(home, "work-codex"), { recursive: true });
    cpSync(join(home, ".claude"), join(home, "work-claude"), { recursive: true });
    const logs = await withSource((read) => read(everything), {
      CODEX_HOME: join(home, "work-codex"),
      CLAUDE_CONFIG_DIR: join(home, "work-claude"),
    });
    const selected = logs.files.filter((file) => file.harness !== "pi").map((file) => file.path.slice(home.length + 1).split("/")[0]);
    expect(selected).toEqual(["work-claude", "work-claude", "work-codex"]);
  });

  test("leaves out a log last written before the earliest window starts", async () => {
    const logs = await withSource((read) => read({ ...everything, pi: Date.now() + 3_600_000 }));
    expect(logs.files.map((file) => file.harness).toSorted()).toEqual(["claude-code", "claude-code", "codex"]);
  });

  test("reads only what a log appended since the last read, so a rewritten earlier line keeps its first reading", async () => {
    const [first, second] = await withSource((read) =>
      Effect.gen(function* () {
        const before = yield* read(everything);
        const text = readFileSync(shopFile(), "utf8");
        const firstLine = text.slice(0, text.indexOf("\n"));
        writeFileSync(shopFile(), "x".repeat(firstLine.length) + text.slice(firstLine.length));
        appendFileSync(shopFile(), `${callLine("2026-10-13T20:15:00.000Z")}\n`);
        return [before, yield* read(everything)] as const;
      }),
    );
    expect(recordsIn(second, shopFile())).toEqual([
      ...recordsIn(first, shopFile()),
      { kind: "pi-call", at: Date.parse("2026-10-13T20:15:00.000Z"), messageAt: undefined, provider: "opencode-go", model: "m", tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
    ]);
  });

  test("holds back a line still being written until its newline lands", async () => {
    const counts = await withSource((read) =>
      Effect.gen(function* () {
        const line = callLine("2026-10-13T20:16:00.000Z");
        appendFileSync(shopFile(), line.slice(0, 40));
        const partial = recordsIn(yield* read(everything), shopFile()).length;
        appendFileSync(shopFile(), `${line.slice(40)}\n`);
        return [partial, recordsIn(yield* read(everything), shopFile()).length];
      }),
    );
    expect(counts).toEqual([5, 6]);
  });

  test("reads a log that shrank from its start, since it was replaced", async () => {
    const counts = await withSource((read) =>
      Effect.gen(function* () {
        const before = recordsIn(yield* read(everything), shopFile()).length;
        writeFileSync(shopFile(), `${callLine("2026-10-13T20:17:00.000Z")}\n`);
        return [before, recordsIn(yield* read(everything), shopFile()).length];
      }),
    );
    expect(counts).toEqual([5, 1]);
  });

  test("reads a log replaced by a shorter one from its start, even when it is longer than what was read", async () => {
    const replacement = await withSource((read) =>
      Effect.gen(function* () {
        const consumed = readFileSync(shopFile(), "utf8").length;
        const line = `${callLine("2026-10-13T20:17:00.000Z")}\n`;
        const calls = Math.floor(consumed / line.length) + 1;
        appendFileSync(shopFile(), "x".repeat(calls * line.length));
        yield* read(everything);
        writeFileSync(shopFile(), line.repeat(calls));
        return [calls, recordsIn(yield* read(everything), shopFile()).length];
      }),
    );
    expect(replacement[1]).toBe(replacement[0]);
  });

  test("reads a log again once a refused first read can succeed, though its size and time are unchanged", async () => {
    const counts = await withSource((read) =>
      Effect.gen(function* () {
        chmodSync(shopFile(), 0o000);
        const refused = recordsIn(yield* read(everything), shopFile()).length;
        chmodSync(shopFile(), 0o644);
        return [refused, recordsIn(yield* read(everything), shopFile()).length];
      }),
    );
    expect(counts).toEqual([0, 5]);
  });
});

const keptCopy = () => join(home, ".local/state/tui-dash/session-logs/session.json");

const readOnce = (): Promise<SessionLogs> => withSource((read) => read(everything));

const byPath = (logs: SessionLogs) => logs.files.toSorted((left, right) => left.path.localeCompare(right.path));

const keptJson = (): unknown => JSON.parse(readFileSync(keptCopy(), "utf8"));

const isKept = (value: unknown): value is { readonly version: number; readonly files: Readonly<Record<string, object>> } =>
  typeof value === "object" &&
  value !== null &&
  "version" in value &&
  typeof value.version === "number" &&
  "files" in value &&
  typeof value.files === "object" &&
  value.files !== null &&
  Object.values(value.files).every((file) => typeof file === "object" && file !== null);

const shopRecords = () => logRecords("pi", readFileSync(shopFile(), "utf8"));

const shopCall = (timestamp: string): LogRecord => ({
  kind: "pi-call",
  at: Date.parse(timestamp),
  messageAt: undefined,
  provider: "opencode-go",
  model: "m",
  tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
});

describe("the session log source across runs, through the copy it keeps on disk, a kept copy that reads the same records and reads no log again", () => {
  test("a second run gives the records the fixture logs hold, the same as the first run that read them", async () => {
    const first = await readOnce();
    for (const file of first.files) expect(file.records).toEqual(logRecords(file.harness, readFileSync(file.path, "utf8")));
    const original = shopRecords();
    expect(original).toHaveLength(5);
    const { mtime } = statSync(shopFile());
    const text = readFileSync(shopFile(), "utf8");
    writeFileSync(shopFile(), text.replace(/"usage"/gu, '"vsage"'));
    utimesSync(shopFile(), mtime, mtime);
    const second = await readOnce();
    expect(byPath(second)).toStrictEqual(byPath(first));
    expect(recordsIn(second, shopFile())).toEqual(original);
  });

  test("a log grown since the kept run is read on from where that run stopped", async () => {
    const original = shopRecords();
    await readOnce();
    const text = readFileSync(shopFile(), "utf8");
    const firstLine = text.slice(0, text.indexOf("\n"));
    writeFileSync(shopFile(), "x".repeat(firstLine.length) + text.slice(firstLine.length));
    appendFileSync(shopFile(), `${callLine("2026-10-13T20:15:00.000Z")}\n`);
    expect(recordsIn(await readOnce(), shopFile())).toEqual([...original, shopCall("2026-10-13T20:15:00.000Z")]);
  });

  test("a log shrunk since the kept run is read from its start", async () => {
    await readOnce();
    writeFileSync(shopFile(), `${callLine("2026-10-13T20:17:00.000Z")}\n`);
    expect(recordsIn(await readOnce(), shopFile())).toEqual([shopCall("2026-10-13T20:17:00.000Z")]);
  });

  test("a log replaced by a shorter one since the kept run is read from its start, though it is longer than what was read", async () => {
    const line = `${callLine("2026-10-13T20:17:00.000Z")}\n`;
    const calls = Math.floor(readFileSync(shopFile(), "utf8").length / line.length) + 1;
    appendFileSync(shopFile(), "x".repeat(calls * line.length));
    await readOnce();
    writeFileSync(shopFile(), line.repeat(calls));
    expect(recordsIn(await readOnce(), shopFile())).toEqual(Array.from({ length: calls }, () => shopCall("2026-10-13T20:17:00.000Z")));
  });
});

describe("a kept copy the next run cannot use is read in full and replaced on disk, never failed or served", () => {
  test("a truncated copy is discarded, the logs are read whole and the copy is written again", async () => {
    await readOnce();
    const whole = keptJson();
    truncateSync(keptCopy(), Math.floor(statSync(keptCopy()).size / 2));
    expect(recordsIn(await readOnce(), shopFile())).toEqual(shopRecords());
    expect(keptJson()).toEqual(whole);
  });

  test("a copy of another format version is discarded, even where its records would still match the logs' sizes and times", async () => {
    await readOnce();
    const whole = keptJson();
    if (!isKept(whole)) throw new Error("the first run kept no versioned copy");
    const shopEmptied = Object.fromEntries(
      Object.entries(whole.files).map(([path, file]) => [path, path === shopFile() ? { ...file, records: [] } : file]),
    );
    writeFileSync(keptCopy(), JSON.stringify({ version: whole.version + 1, files: shopEmptied }));
    expect(recordsIn(await readOnce(), shopFile())).toEqual(shopRecords());
    expect(keptJson()).toEqual(whole);
  });

  test("an unreadable copy is read past and replaced", async () => {
    await readOnce();
    const whole = keptJson();
    chmodSync(keptCopy(), 0o000);
    expect(recordsIn(await readOnce(), shopFile())).toEqual(shopRecords());
    expect(keptJson()).toEqual(whole);
  });

  test("a state directory nothing can be written under still gives every record", async () => {
    const logs = await withSource((read) => read(everything), { XDG_STATE_HOME: "/dev/null" });
    expect(recordsIn(logs, shopFile())).toEqual(shopRecords());
  });
});

describe("decodeHerdrPanes against herdr agent list", () => {
  test("keeps each pane, with the session path where Herdr names one", () => {
    const panes = valueOf(decodeHerdrPanes(fixture("session-logs/herdr-agents.json")));
    expect(panes.map((pane) => [pane.pane_id, pane.agent_session?.kind])).toEqual([
      ["w1A:p2", "path"],
      ["w2B:p2", "path"],
      ["w3C:p2", undefined],
      ["w4D:p2", "path"],
    ]);
  });

  test("refuses a list without its agents", () => {
    expect(issueOf(decodeHerdrPanes('{"result":{}}'))).toContain("agents");
  });
});

describe("the harness process tables", () => {
  test("reads pid, parent, program and working directory from the Linux /proc walk", () => {
    const rows = valueOf(decodeLinuxHarnessProcesses(fixture("session-logs/harness-processes.txt")));
    expect(rows.map((row) => [row.pid, row.parent, row.program])).toEqual([
      [1001, 900, "pi"],
      [1002, 900, "pi"],
      [4242, 669, "pi"],
      [4243, 4242, "claude"],
    ]);
    expect(rows[2]?.cwd).toBe("/home/tester/.no-mistakes/worktrees/abc123/01JRUNULID0000000000RUN42");
  });

  test("refuses a program it does not track", () => {
    expect(decodeLinuxHarnessProcesses("1 0 bash /tmp\n").kind).toBe("invalid");
  });

  test("reads lsof field output on macOS, and drops pip, which lsof's prefix match lets in", () => {
    const rows = valueOf(decodeMacHarnessProcesses(fixture("session-logs/harness-processes-mac.txt")));
    expect(rows.map((row) => [row.pid, row.parent, row.program, row.cwd])).toEqual([
      [1001, 900, "pi", "/home/tester/.treehouse/shop-a1b2c3/1/shop"],
      [4242, 669, "pi", "/home/tester/.no-mistakes/worktrees/abc123/01JRUNULID0000000000RUN42"],
      [4243, 4242, "claude", "/home/tester/.no-mistakes/worktrees/abc123/01JRUNULID0000000000RUN42"],
    ]);
  });
});
