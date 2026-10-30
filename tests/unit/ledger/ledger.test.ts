import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { lineWidth, plain } from "@tui-dash/ui";
import {
  fullHints,
  ledgerFull,
  ledgerShown,
  ledgerTitle,
  saidOfTurns,
  saidToday,
  type SaidMessage,
  type SessionTurn,
  windowOf,
} from "@tui-dash/ledger";
import { dashboardNow } from "../../lib/dashboard-fixture";

const minutes = (n: number): DateTime.Utc => DateTime.addDuration(dashboardNow, `${0 - n} minutes`);

const utc = DateTime.zoneMakeNamedUnsafe("UTC");

const turn = (over: Partial<SessionTurn> & { line: number }): SessionTurn => ({
  file: "2026-10-19T07-00-00-000Z_chat.jsonl",
  at: minutes(30),
  role: "user",
  text: "",
  operational: false,
  ...over,
});

const said = (over: Partial<SaidMessage> & { id: string }): SaidMessage => ({
  at: minutes(30),
  who: { role: "you" as const },
  text: "a message",
  ...over,
});

const assistant = { role: "agent" as const, name: "assistant" };

const addressed = { name: "assistant", address: "Chief,", ack: "Chief, done." };

const chat = [
  turn({ line: 1, role: "user", text: "Ship the ledger board today." }),
  turn({ line: 2, role: "user", text: "<task>do the thing</task>", operational: true }),
  turn({ line: 3, role: "assistant", text: "Running the tests now." }),
  turn({ line: 4, role: "assistant", text: "Chief, done." }),
  turn({ line: 5, role: "assistant", text: "Chief, the compact box keeps one line per message." }),
  turn({ line: 6, role: "user", text: "   " }),
];

// Oracle: the ledger settings in the README, where an operational message is hidden, a set address keeps only the replies
// that open with it and shows them without it, and the exact ack is left out. Rejects the ack kept as news, an
// unaddressed reply folded into the day, and, with no address set, a reply dropped for lacking one.
describe("the conversation feed", () => {
  test("keeps your words, drops the operational ones, and keeps addressed replies without the address", () => {
    expect(saidOfTurns("chat.jsonl", chat, addressed)).toEqual([
      { id: "m-chat.jsonl-1", at: minutes(30), who: { role: "you" }, text: "Ship the ledger board today." },
      { id: "m-chat.jsonl-5", at: minutes(30), who: assistant, text: "the compact box keeps one line per message." },
    ]);
  });

  test("keeps every reply whole when no address or ack is set", () => {
    const feed = saidOfTurns("chat.jsonl", chat, { name: "assistant", address: undefined, ack: undefined });
    expect(feed.map((message) => [message.who, message.text])).toEqual([
      [{ role: "you" }, "Ship the ledger board today."],
      [assistant, "Running the tests now."],
      [assistant, "Chief, done."],
      [assistant, "Chief, the compact box keeps one line per message."],
    ]);
  });

  test("drops yesterday and reads chat order across files", () => {
    const feed = saidToday(
      [
        said({ id: "b", at: minutes(20) }),
        said({ id: "a", at: minutes(40) }),
        said({ id: "old", at: DateTime.addDuration(dashboardNow, "-26 hours") }),
      ],
      dashboardNow,
      utc,
    );
    expect(feed.map((message) => message.id)).toEqual(["a", "b"]);
  });

  test("titles the box for today", () => {
    expect(ledgerTitle).toBe("ledger \u00b7 today");
  });
});

// Oracle: the compact box, where the newest message sits on the bottom row, the earlier ones fold into one faint count,
// and a cut line ends in an ellipsis. Rejects a newest message anywhere but the bottom, and a hidden count that miscounts.
describe("the compact ledger", () => {
  const feed: ReadonlyArray<SaidMessage> = [
    said({ id: "m-early", at: minutes(300), text: "Ship the ledger board today." }),
    said({ id: "m-plan", at: minutes(290), who: assistant, text: "The compact box keeps one line per message." }),
    said({ id: "m-ask", at: minutes(120), text: "Does l open the full screen?" }),
    said({
      id: "m-full",
      at: minutes(25),
      who: assistant,
      text: "Yes. l takes the full screen, and the cursor opens a message for the full text:\nits wrapped words stay readable beside the time.",
    }),
  ];

  test("reads chat order with the newest on the bottom and each age beside its words", () => {
    const shown = ledgerShown(feed, dashboardNow, 60, 10, undefined, undefined);
    expect(shown.hidden).toBe(0);
    expect(shown.lines.map(plain)).toEqual([
      "\u25cb Ship the ledger board today. \u00b7 5h",
      "\u25cf The compact box keeps one line per message. \u00b7 4h",
      "\u25cb Does l open the full screen? \u00b7 2h",
      "\u25cf Yes. l takes the full screen, and the cursor opens\u2026 \u00b7 25m",
    ]);
    expect(shown.rows.map((row) => row.id)).toEqual(["m-early", "m-plan", "m-ask", "m-full"]);
  });

  test("joins a reply ending on a colon with its next line, and cuts a long line with an ellipsis", () => {
    const joined = ledgerShown(
      [said({ id: "j", at: minutes(5), who: assistant, text: "The verdict:\nship it today." })],
      dashboardNow,
      40,
      10,
      undefined,
      undefined,
    );
    expect(plain(joined.lines[0] ?? [])).toBe("\u25cf The verdict: ship it today. \u00b7 5m");
    const shown = ledgerShown(feed, dashboardNow, 40, 10, undefined, undefined);
    const last = plain(shown.lines.at(-1) ?? []);
    expect(last).toBe("\u25cf Yes. l takes the full screen, a\u2026 \u00b7 25m");
    expect(lineWidth(shown.lines.at(-1) ?? [])).toBeLessThanOrEqual(40);
  });

  test("folds the messages past the room into one faint earlier count on top", () => {
    const shown = ledgerShown(feed, dashboardNow, 60, 3, undefined, undefined);
    expect(shown.hidden).toBe(2);
    expect(shown.lines.map(plain)).toEqual([
      "\u2191 2 earlier",
      "\u25cb Does l open the full screen? \u00b7 2h",
      "\u25cf Yes. l takes the full screen, and the cursor opens\u2026 \u00b7 25m",
    ]);
    expect(shown.rows.map((row) => row.id)).toEqual(["m-ask", "m-full"]);
    expect(shown.lines[0]?.[0]?.style.tone).toBe("faint");
  });

  test("paints the picked row in the focus tone and none without a pick", () => {
    const picked = ledgerShown(feed, dashboardNow, 60, 10, "m-ask", "pick");
    expect(picked.lines[2]?.[1]?.style).toEqual(expect.objectContaining({ background: "pick" }));
    const unpicked = ledgerShown(feed, dashboardNow, 60, 10, undefined, "pick");
    expect(unpicked.lines.flatMap((line) => line.map((part) => part.style.background))).not.toContain("pick");
  });
});

// Oracle: the full screen, where every message keeps one line with its time and speaker, the open one wraps
// its plain words beside them, and the hints stay faint on the last row. Rejects an open message still folded,
// and a cursor that scrolled out of sight.
describe("the full-screen ledger", () => {
  const feed: ReadonlyArray<SaidMessage> = [
    said({ id: "m-early", at: minutes(300), text: "Ship the ledger board today." }),
    said({ id: "m-ask", at: minutes(120), text: "Does l open the full screen?" }),
    said({
      id: "m-full",
      at: minutes(25),
      who: assistant,
      text: "Yes. l takes the full screen, and the open message wraps its plain words beside the time, *without* the `markdown`.",
    }),
  ];

  test("folds every message to one line with its time and speaker", () => {
    const full = ledgerFull(feed, utc, 60, 10, undefined, undefined, 0);
    expect(full.lines.map((line) => plain(line).trimEnd())).toEqual([
      "15:18 you Ship the ledger board today.",
      "",
      "18:18 you Does l open the full screen?",
      "",
      "19:53 assistant Yes. l takes the full screen, and the open\u2026",
      "",
    ]);
    expect(full.top).toBe(0);
    expect(full.shown).toBe(3);
    expect(full.hidden).toBe(0);
    expect(full.rows.map((row) => [row.line, row.id])).toEqual([[0, "m-early"], [2, "m-ask"], [4, "m-full"]]);
  });

  test("opens the picked message into wrapped words beside its time", () => {
    const full = ledgerFull(feed, utc, 40, 10, "m-full", "m-full", 0);
    expect(full.lines.map((line) => plain(line).trimEnd())).toEqual([
      "\u2191 1 earlier",
      "18:18 you Does l open the full screen?",
      "",
      "19:53 assistant Yes. l takes the full",
      "                screen, and the open",
      "                message wraps its plain",
      "                words beside the time,",
      "                *without* the",
      "                `markdown`.",
      "",
    ]);
  });

  test("keeps an exact-fit open message inside the room so the hints row stays", () => {
    const body = Array.from({ length: 36 }, (_, index) => `line ${index + 1}`).join("\n");
    const exact: ReadonlyArray<SaidMessage> = [
      said({ id: "m-short", at: minutes(300), text: "hello" }),
      said({ id: "m-tall", at: minutes(25), who: assistant, text: body }),
    ];
    const full = ledgerFull(exact, utc, 60, 37, "m-tall", "m-tall", 0);
    expect(full.lines.length).toBe(37);
    expect(plain(full.lines.at(-1) ?? []).trimEnd()).toBe(`${" ".repeat(16)}line 36`);
  });

  test("opens indented lines, blank lines and repeated spaces verbatim", () => {
    const code: ReadonlyArray<SaidMessage> = [
      said({ id: "m-code", at: minutes(25), who: assistant, text: "if ready:\n ship()\n\nnext()" }),
    ];
    const full = ledgerFull(code, utc, 40, 10, "m-code", "m-code", 0);
    const texts = full.lines.map((line) => plain(line).trimEnd());
    expect(texts[1]).toBe(`${" ".repeat(16)} ship()`);
    expect(texts[2]).toBe("");
    const spaced: ReadonlyArray<SaidMessage> = [said({ id: "m-sp", at: minutes(25), text: "a  b   c" })];
    const open = ledgerFull(spaced, utc, 40, 10, "m-sp", "m-sp", 0);
    expect(plain(open.lines[0] ?? []).trimEnd().endsWith("a  b   c")).toBe(true);
  });

  test("holds folded messages and the marker inside two rows on a five-row screen", () => {
    const two: ReadonlyArray<SaidMessage> = [
      said({ id: "m-one", at: minutes(300), text: "first" }),
      said({ id: "m-two", at: minutes(25), text: "second" }),
    ];
    const full = ledgerFull(two, utc, 60, 2, "m-two", undefined, 0);
    expect(full.lines.length).toBeLessThanOrEqual(2);
    expect(full.rows.every((row) => row.line < full.lines.length)).toBe(true);
  });

  test("leaves the hints bound when the marker fills the only row", () => {
    const tall: ReadonlyArray<SaidMessage> = [
      said({ id: "m-one", at: minutes(300), text: "first" }),
      said({ id: "m-tall", at: minutes(25), who: assistant, text: "one\ntwo\nthree\nfour\nfive" }),
    ];
    const full = ledgerFull(tall, utc, 60, 1, "m-tall", "m-tall", 0);
    expect(full.lines.length).toBeLessThanOrEqual(1);
    expect(full.rows.every((row) => row.line < full.lines.length)).toBe(true);
  });

  test("follows the cursor out of the window instead of stranding it", () => {
    const top = windowOf([2, 2, 2, 2], 5, 0, 3);
    expect(top).toEqual({ top: 2, count: 2 });
    const climbed = windowOf([2, 2, 2, 2], 5, 2, 0);
    expect(climbed).toEqual({ top: 0, count: 2 });
    const full = ledgerFull(feed, utc, 60, 5, "m-early", undefined, 2);
    expect(plain(full.lines[0] ?? []).trimEnd()).toBe("15:18 you Ship the ledger board today.");
    expect(full.hidden).toBe(0);
  });

  test("names a pasted image in the open message and keeps his words", () => {
    const open = ledgerFull(
      [said({ id: "m-clip", at: minutes(5), text: "ship this /var/folders/ab/T/pi-clipb12.png" })],
      utc,
      40,
      10,
      "m-clip",
      "m-clip",
      0,
    );
    expect(open.lines.map((line) => plain(line).trimEnd()).join("\n")).toContain("ship this pasted image");
  });

  test("keeps the hints faint on one line", () => {
    expect(plain(fullHints(80))).toBe("\u2191\u2193 move \u23ce or click open pgup pgdn page l or esc back");
    expect(fullHints(80)[0]?.style.tone).toBe("faint");
    expect(lineWidth(fullHints(20))).toBeLessThanOrEqual(20);
  });
});

// Oracle: a pasted clipboard image arrives as its temp path beside his words, where the folded row and the open message name it and keep his words.
// Rejects the raw temp path on either, and his words dropped with the path.
describe("a pasted clipboard image", () => {
  const clip = "/var/folders/ab/T/pi-clipb12.png";

  test("names the image on the folded row and keeps his words", () => {
    const shown = ledgerShown(
      [said({ id: "m-clip", at: minutes(5), text: `look at this ${clip} please` })],
      dashboardNow,
      60,
      10,
      undefined,
      undefined,
    );
    expect(shown.lines.map(plain)).toEqual(["\u25cb look at this pasted image please \u00b7 5m"]);
    const lone = ledgerShown(
      [said({ id: "m-lone", at: minutes(5), text: clip })],
      dashboardNow,
      60,
      10,
      undefined,
      undefined,
    );
    expect(lone.lines.map(plain)).toEqual(["\u25cb pasted image \u00b7 5m"]);
  });
});
