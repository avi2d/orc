import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Harness } from "@tui-dash/schema";

interface PerKilobyte {
  readonly objects: number;
  readonly quotes: number;
  readonly escapes: number;
  readonly newlines: number;
  readonly accents: number;
}

interface Lines {
  readonly bytes: number;
  readonly shape: PerKilobyte;
}

interface Volume {
  readonly files: number;
  readonly olderFiles: number;
  readonly folders: number;
  readonly bytes: number;
  readonly markedLineShare: number;
  readonly marked: Lines;
  readonly unmarked: Lines;
}

type Logged = Exclude<Harness, "codex">;

// A busy machine's pi and Claude Code logs over the seven days the session quota reads back, and the older files it lists and passes
// over; no Codex log was written in them. Escapes count backslashes other than an escaped newline, and accents count
// two-byte characters.
const busyWeek = {
  pi: {
    files: 545,
    olderFiles: 622,
    folders: 306,
    bytes: 822_000_000,
    markedLineShare: 0.484,
    marked: { bytes: 4_839, shape: { objects: 2.28, quotes: 26.8, escapes: 5.5, newlines: 2.5, accents: 4.5 } },
    unmarked: { bytes: 14_300, shape: { objects: 1.16, quotes: 9.5, escapes: 3.4, newlines: 3, accents: 5.2 } },
  },
  "claude-code": {
    files: 883,
    olderFiles: 4_460,
    folders: 442,
    bytes: 929_000_000,
    markedLineShare: 0.362,
    marked: { bytes: 3_571, shape: { objects: 4.07, quotes: 62, escapes: 2.7, newlines: 1.6, accents: 3.3 } },
    unmarked: { bytes: 9_271, shape: { objects: 0.83, quotes: 8.7, escapes: 2.4, newlines: 3.4, accents: 3.2 } },
  },
} as const satisfies Record<Logged, Volume>;

export const busyWeekBytes = busyWeek.pi.bytes + busyWeek["claude-code"].bytes;

const words = "the build reads every task and writes its plan before the queue drains while an agent checks the run ";

const textOf = (length: number, seed: number): string => {
  const start = seed % words.length;
  return words.repeat(Math.ceil((length + start) / words.length) + 1).slice(start, start + length);
};

const sprinkled = (length: number, newlines: number, escapes: number, accents: number, seed: number): string => {
  const marks = [...Array.from({ length: newlines }, () => "\\n"), ...Array.from({ length: escapes }, () => '\\"'), ...Array.from({ length: accents }, () => "\u00e9")];
  const plain = Math.max(0, length - 2 * marks.length);
  if (marks.length === 0) return textOf(plain, seed);
  const step = Math.max(1, Math.floor(plain / marks.length));
  return marks.map((mark, at) => textOf(step, seed + at) + mark).join("") + textOf(plain - step * marks.length, seed);
};

const share = (total: number, parts: number, part: number): number => Math.floor((total * (part + 1)) / parts) - Math.floor((total * part) / parts);

const occurrences = (text: string, mark: string): number => text.split(mark).length - 1;

// A line `length` bytes long whose content, an array of objects of string fields, brings the whole line to its shape's
// objects, strings and escapes in every kilobyte.
const lineOf = (envelope: (content: string) => string, length: number, shape: PerKilobyte, seed: number): string => {
  const bare = envelope("[]");
  const kilobytes = length / 1_000;
  const count = (perKilobyte: number) => Math.max(0, Math.round(perKilobyte * kilobytes));
  const objects = Math.max(1, count(shape.objects) - occurrences(bare, "{"));
  const newlines = count(shape.newlines);
  const escapes = count(shape.escapes);
  const fields = Math.max(objects, Math.round((count(shape.quotes) - occurrences(bare, '"') - escapes) / 4));
  const accents = count(shape.accents);
  const text = Math.max(fields, length - bare.length - objects * 3 - fields * 8);
  let field = 0;
  const objectsText = Array.from({ length: objects }, (_, object) => {
    const pairs = Array.from({ length: share(fields, objects, object) }, () => {
      const at = field++;
      return `"k${at % 10}":"${sprinkled(share(text, fields, at), share(newlines, fields, at), share(escapes, fields, at), share(accents, fields, at), seed + at)}"`;
    });
    return `{${pairs.join(",")}}`;
  });
  return envelope(`[${objectsText.join(",")}]`);
};

type Envelope = (marked: boolean, seed: number, time: string) => (content: string) => string;

const piEnvelope: Envelope = (marked, seed, time) => (content) =>
  marked
    ? `{"type":"message","id":"m${seed}","parentId":"p","timestamp":"${time}","message":{"role":"assistant","content":${content},"api":"x","provider":"claude-bridge","model":"claude-opus-5-5","usage":{"input":3,"output":2000,"cacheRead":150000,"cacheWrite":8000,"totalTokens":160003}}}`
    : `{"type":"message","id":"m${seed}","parentId":"p","timestamp":"${time}","message":{"role":"toolResult","content":${content}}}`;

const claudeEnvelope: Envelope = (marked, seed, time) => (content) =>
  marked
    ? `{"type":"assistant","timestamp":"${time}","cwd":"/home/tester/work","entrypoint":"cli","requestId":"req_${seed}","sessionId":"c","isSidechain":false,"message":{"id":"msg_${seed}","model":"claude-opus-5-5","role":"assistant","content":${content},"usage":{"input_tokens":10,"output_tokens":400,"cache_read_input_tokens":20000,"cache_creation_input_tokens":5000}}}`
    : `{"type":"user","timestamp":"${time}","cwd":"/home/tester/work","sessionId":"c","isSidechain":false,"message":{"role":"user","content":${content}}}`;

const pathOf = (home: string, harness: Logged, folder: number, file: number): string =>
  harness === "pi"
    ? `${home}/.pi/agent/sessions/--home-tester-work-${folder}--/2026-10-20T08-00-00-000Z_${file}.jsonl`
    : `${home}/.claude/projects/-home-tester-work-${folder}/${file}.jsonl`;

const spreads = [0.25, 0.5, 1, 1.25, 2] as const;
const lineSpreads = [0.5, 1, 1.5] as const;
const dayMillis = 86_400_000;

export interface Corpus {
  readonly bytes: number;
  readonly markedLines: number;
}

const weekLines = (harness: Logged, file: number, now: number): ReadonlyArray<string> => {
  const volume: Volume = busyWeek[harness];
  const envelope = harness === "pi" ? piEnvelope : claudeEnvelope;
  const meanLine = volume.markedLineShare * volume.marked.bytes + (1 - volume.markedLineShare) * volume.unmarked.bytes;
  const count = Math.max(1, Math.round((volume.bytes / volume.files / meanLine) * (spreads[file % spreads.length] ?? 1)));
  const time = (line: number) => new Date(now - ((file * 997 + line * 13) % (6 * dayMillis))).toISOString();
  const session = `{"type":"session","version":3,"id":"s${file}","timestamp":"${time(0)}","cwd":"/home/tester/work/${file}"}`;
  const lines = Array.from({ length: count }, (_, line) => {
    const marked = (line * 37) % 1_000 < volume.markedLineShare * 1_000;
    const kind = marked ? volume.marked : volume.unmarked;
    const seed = file * 100_003 + line;
    return lineOf(envelope(marked, seed, time(line)), Math.round(kind.bytes * (lineSpreads[line % lineSpreads.length] ?? 1)), kind.shape, seed);
  });
  return harness === "pi" ? [session, ...lines] : lines;
};

const written = (path: string, text: string): number => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return Buffer.byteLength(text);
};

// Writes one in every `fraction` of the week's files and of the older ones, in as many folders, each of the week's files the
// week's mean size on average and spread as its files are. Every marked line carries one record and no other line does.
export const writeWeekShare = (home: string, fraction: number, now: number): Corpus => {
  let bytes = 0;
  let markedLines = 0;
  for (const harness of ["pi", "claude-code"] as const) {
    const volume: Volume = busyWeek[harness];
    const folders = Math.max(1, Math.round(volume.folders / fraction));
    const files = Math.round(volume.files / fraction);
    for (let file = 0; file < files; file++) {
      const lines = weekLines(harness, file, now);
      markedLines += lines.filter((line) => line.includes('"usage"') || line.includes('"type":"session"')).length;
      bytes += written(pathOf(home, harness, file % folders, file), `${lines.join("\n")}\n`);
    }
    const older = new Date(now - 8 * dayMillis);
    const envelope = harness === "pi" ? piEnvelope : claudeEnvelope;
    for (let file = files; file < files + Math.round(volume.olderFiles / fraction); file++) {
      const path = pathOf(home, harness, file % folders, file);
      written(path, lineOf(envelope(true, file, older.toISOString()), volume.marked.bytes, volume.marked.shape, file));
      utimesSync(path, older, older);
    }
  }
  return { bytes, markedLines };
};
