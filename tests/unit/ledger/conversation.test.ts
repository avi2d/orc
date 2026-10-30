import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, DateTime, Effect, Layer } from "effect";
import { type Command, CommandUnreachable } from "@tui-dash/schema";
import { ConversationSource, conversationSourceLive, type LedgerFeed, makeConversationReader } from "@tui-dash/ledger";

const utc = DateTime.zoneMakeNamedUnsafe("UTC");
const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso);

const ordinary = "Should we ship the fix today?";
const operational = "OPERATIONAL watcher wake: branch done";
const classifier = "operational-input classify";

const run = (command: Command): Effect.Effect<string, CommandUnreachable> =>
  command.argv[0] === "sh" && command.argv[4] === classifier
    ? Effect.succeed(command.argv[5].includes("OPERATIONAL") ? "operational\n" : "")
    : Effect.fail(new CommandUnreachable({ reason: `unexpected ${command.argv.join(" ")}` }));

const recorded = Layer.succeed(ConversationSource, makeConversationReader({ run }));

const readWith = (source: Layer.Layer<ConversationSource>, env: Record<string, string>, now: DateTime.Utc): Promise<LedgerFeed> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const conversation = yield* ConversationSource;
      return yield* conversation.read(now, utc);
    }).pipe(Effect.provide(Layer.mergeAll(source, BunFileSystem.layer, ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))))),
  );

const saidOf = (feed: LedgerFeed) => (feed.sessions === "set" ? feed.said : []);

const sessionLine = (stamp: string, role: "user" | "assistant", text: string): string =>
  JSON.stringify({ type: "message", timestamp: stamp, message: { role, content: [{ type: "text", text }] } });

const sessionsWith = async (lines: ReadonlyArray<string>): Promise<{ readonly dir: string; readonly sessions: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-sessions-"));
  const sessions = join(dir, "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, "s.jsonl"), lines.join("\n") + "\n");
  return { dir, sessions };
};

// Oracle: the README's ledger settings, where the ledger stays empty until TUI_DASH_LEDGER_SESSIONS names a folder.
// Rejects a ledger that falls back to session files somewhere under the home folder.
describe("the conversation reader without configured sessions", () => {
  test("yields an empty ledger instead of reading the real home", async () => {
    const stamp = new Date().toISOString();
    const { dir } = await sessionsWith([sessionLine(stamp, "user", ordinary)]);
    await mkdir(join(dir, ".pi/agent/sessions"), { recursive: true });
    await writeFile(join(dir, ".pi/agent/sessions/s.jsonl"), sessionLine(stamp, "user", ordinary) + "\n");
    expect(await readWith(recorded, { HOME: dir }, at(stamp))).toEqual({ sessions: "unset" });
  });
});

// Oracle: the README's classifier contract, where the command TUI_DASH_LEDGER_CLASSIFY names reads the message on stdin
// and prints something only for an operational one. Rejects the operational turn shown as said by you.
describe("the live ledger's operational filter", () => {
  test("shows only the ordinary question, never the operational turn as said by you", async () => {
    const stamp = new Date().toISOString();
    const { dir, sessions } = await sessionsWith([sessionLine(stamp, "user", ordinary), sessionLine(stamp, "user", operational)]);
    const said = await readWith(recorded, { HOME: dir, TUI_DASH_LEDGER_SESSIONS: sessions, TUI_DASH_LEDGER_CLASSIFY: classifier }, at(stamp));
    expect(saidOf(said).map((message) => [message.who.role, message.text])).toEqual([["you", ordinary]]);
  });

  test("runs the configured classifier through the shell with the message on stdin", async () => {
    const stamp = new Date().toISOString();
    const { dir, sessions } = await sessionsWith([
      sessionLine(stamp, "user", ordinary),
      sessionLine(stamp, "user", operational),
      sessionLine(stamp, "assistant", "Chief, shipped."),
      sessionLine(stamp, "assistant", "thinking aloud"),
    ]);
    const said = await readWith(
      conversationSourceLive,
      {
        HOME: dir,
        TUI_DASH_LEDGER_SESSIONS: sessions,
        TUI_DASH_LEDGER_CLASSIFY: "grep -q OPERATIONAL && echo operational",
        TUI_DASH_LEDGER_ADDRESS: "Chief,",
        TUI_DASH_LEDGER_AGENT: "helper",
      },
      at(stamp),
    );
    expect(saidOf(said).map((message) => [message.who, message.text])).toEqual([
      [{ role: "you" }, ordinary],
      [{ role: "agent", name: "helper" }, "shipped."],
    ]);
  });
});
