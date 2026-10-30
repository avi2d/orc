import { describe, expect, test } from "bun:test";
import { DateTime, Schema } from "effect";
import {
  type AccountView,
  composedSessionQuota,
  type CountedCall,
  decodeSavedProfiles,
  decodeQuota,
  type Session,
  SessionQuotaReport,
  sessionQuotaReport,
  type SessionQuotaView,
  sessionQuotaView,
  sessionQuotaViewOf,
  type WindowView,
} from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { machineView } from "../../lib/machines-fixture";
import { valueOf } from "../../lib/outcomes";
import { quotaAxiRead } from "../../lib/quota-read";

type Identity = Pick<AccountView, "accountKey" | "credentialKey" | "joins">;

// A machine's one Codex account, named as identity says, whose week has 40 points used and whose one pane spent 100 input tokens.
const codexWeekOn = (machine: "north" | "south", identity: Identity): SessionQuotaView => {
  const template = machineView("north")
    .accounts.flatMap((account) => (account.provider === "codex" && account.body.kind === "windows" ? account.body.windows : []))
    .find((window) => window.id === "weekly");
  const alone = machineView(machine);
  const session = alone.sessions.find((found) => found.id === "pane:w1");
  if (template === undefined || session === undefined) throw new Error("the fixture lacks the Codex week or pane w1");
  const tokens = { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 };
  const whole = { share: 1, contributionPoints: 40, pointsPerHour: 0 };
  const window: WindowView = {
    ...template,
    usedPoints: 40,
    observedCalls: 1,
    observedTokens: tokens,
    sessions: [{ session, label: "w1", calls: 1, tokens, trailingHourTokens: tokens, raw: whole, priced: whole, models: [], flagged: false }],
  };
  return { ...alone, accounts: [{ provider: "codex", title: "codex", accountKeys: [], ...identity, body: { kind: "windows", windows: [window] } }] };
};

const codexPoints = (composed: SessionQuotaView) =>
  composed.accounts
    .filter((account) => account.provider === "codex")
    .map((account) =>
      account.body.kind === "windows"
        ? account.body.windows.flatMap((window) => window.sessions.map((row) => [row.session.machine, row.priced.contributionPoints]))
        : [],
    );

const keyedTo = (key: string): Identity["joins"] => [{ kind: "credential-key", key }];

describe("one Codex login composed from two machines that name it differently", () => {
  test("composes one login named differently by a current and a legacy report into one Codex account, not two rows each claiming all 40 points", () => {
    const coalesced = { accountKey: "openai-codex-work", credentialKey: "codex-home", joins: [] };
    const harvested = { accountKey: undefined, credentialKey: "codex-home", joins: keyedTo("codex-home") };
    const legacyCoalesced = { accountKey: "openai-codex-work", credentialKey: undefined, joins: keyedTo("codex-home") };
    const piOnly = { accountKey: undefined, credentialKey: "openai-codex", joins: keyedTo("openai-codex") };
    const legacyPiOnly = { accountKey: undefined, credentialKey: undefined, joins: keyedTo("openai-codex") };
    const legacyUnkeyed = { accountKey: undefined, credentialKey: undefined, joins: [] };
    const pairs: ReadonlyArray<readonly [Identity, Identity]> = [
      [coalesced, legacyCoalesced],
      [harvested, legacyCoalesced],
      [piOnly, legacyPiOnly],
      [piOnly, legacyUnkeyed],
    ];
    for (const [local, peer] of pairs) {
      const together = composedSessionQuota(codexWeekOn("north", local), "north", [
        { name: "south", reading: { kind: "ok", value: codexWeekOn("south", peer) } },
      ]);
      expect(codexPoints(together)).toEqual([
        [
          ["north", 20],
          ["south", 20],
        ],
      ]);
    }
  });

  test("keeps two Codex logins apart, and a keyless account beside them, each with its own 40 points", () => {
    const together = composedSessionQuota(
      codexWeekOn("north", { accountKey: undefined, credentialKey: "codex-home", joins: keyedTo("codex-home") }),
      "north",
      [
        {
          name: "south",
          reading: { kind: "ok", value: codexWeekOn("south", { accountKey: undefined, credentialKey: "openai-codex", joins: [] }) },
        },
        {
          name: "west",
          reading: { kind: "ok", value: codexWeekOn("south", { accountKey: undefined, credentialKey: undefined, joins: [{ kind: "only-account" }] }) },
        },
      ],
    );
    expect(codexPoints(together)).toEqual([[["north", 40]], [["south", 40]], [["west", 40]]]);
  });
});

const readAt = Date.parse("2026-10-16T19:00:00Z");

// quota-axi's report of one Codex row under accountKey with the aliases accountKeys lists, its week 40 points used.
const codexQuota = (accountKey: string, accountKeys: ReadonlyArray<string>): string =>
  JSON.stringify({
    generatedAt: new Date(readAt).toISOString(),
    schemaVersion: 5,
    providers: [
      {
        provider: "codex",
        accountKey,
        accountKeys,
        windows: [
          {
            id: "weekly",
            label: "week",
            kind: "weekly",
            percentRemaining: 60,
            resetsAt: "2026-10-19T19:00:00Z",
            pace: { status: "ahead", cycleSeconds: 604800 },
          },
        ],
        state: { status: "fresh", stale: false },
      },
    ],
  });

// One machine's view of its one pane, which spent 100 input tokens on Codex under credentialKey, read from quota-axi.
const quotaAxiView = (quotaJson: string, call: Pick<CountedCall, "harness" | "route" | "credentialKey">): SessionQuotaView => {
  const session: Session = {
    id: "pane:w1",
    identity: { kind: "pane", pane: "w1", status: "working" },
    harness: call.harness,
    cwd: "/work/w1",
    place: "/work/w1",
    files: ["/logs/w1.jsonl"],
  };
  const now = DateTime.makeUnsafe(readAt);
  const tokens = { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 };
  return sessionQuotaView({
    quota: quotaAxiRead({ ...decodeQuota(quotaJson), capturedAt: now }),
    savedProfiles: { ...decodeSavedProfiles(fixture("saved-profiles/status.json")), capturedAt: now },
    panes: undefined,
    processes: undefined,
    ledger: {
      calls: [{ ...call, file: "/logs/w1.jsonl", at: readAt - 600_000, quota: "codex", model: undefined, tokens }],
      bridgeCopiesDropped: 0,
      repeatedLinesDropped: 0,
      emptyRowsDropped: 0,
      forkCopiesDropped: 0,
      repeatedCountsDropped: 0,
    },
    sessions: [session],
    sessionOfFile: new Map([["/logs/w1.jsonl", session.id]]),
    unmatched: [],
    now,
    timeZone: DateTime.zoneMakeNamedUnsafe("UTC"),
  });
};

// A peer's view as it reaches this machine: its report printed as JSON and read back.
const sentAsReport = (view: SessionQuotaView, machine: string): SessionQuotaView =>
  valueOf(sessionQuotaViewOf(Schema.decodeUnknownSync(SessionQuotaReport)(JSON.parse(JSON.stringify(sessionQuotaReport(view)))), machine));

describe("one Codex subscription two machines read under different credentials", () => {
  test("composes north's coalesced row and south's openai-codex row into one account, whichever machine is the peer, not two rows each claiming all 40 points", () => {
    const north = quotaAxiView(codexQuota("openai-codex-work", ["openai-codex-work", "codex-home", "openai-codex"]), {
      harness: "codex",
      route: "codex",
      credentialKey: "codex-home",
    });
    const south = quotaAxiView(codexQuota("openai-codex", ["openai-codex"]), {
      harness: "pi",
      route: "openai-codex",
      credentialKey: "openai-codex",
    });
    const orders = [
      composedSessionQuota(north, "north", [{ name: "south", reading: { kind: "ok", value: sentAsReport(south, "south") } }]),
      composedSessionQuota(south, "south", [{ name: "north", reading: { kind: "ok", value: sentAsReport(north, "north") } }]),
    ];
    for (const together of orders) {
      expect(codexPoints(together).map((rows) => rows.toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))))).toEqual([
        [
          ["north", 20],
          ["south", 20],
        ],
      ]);
    }
  });
});
