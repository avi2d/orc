import { describe, expect, test } from "bun:test";
import { markedLogRecords } from "@tui-dash/schema";

const byteOrderMark = [0xef, 0xbb, 0xbf];

const bytesOf = (...parts: ReadonlyArray<string | ReadonlyArray<number>>): Uint8Array =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...new TextEncoder().encode(part)] : [...part])));

const sessions = (bytes: Uint8Array) => markedLogRecords("pi", bytes).map((record) => (record.kind === "pi-session" ? record.cwd : record.kind));

// The Encoding standard strips the byte order mark only at the start, and JSON whitespace leaves out U+FEFF.
describe("markedLogRecords, marks read per line, an unterminated last line kept", () => {
  test("reads the marked lines the way the text decoded whole reads them", () => {
    const bytes = bytesOf(
      byteOrderMark,
      '{"type":"session","cwd":"/work/caf\u00e9"}\n',
      '{"type":"note","text":"no marker on this line \u00fc"}\n',
      '{"type":"session","cwd":"/work/\u65e5\u672c","usage":1}\n',
      byteOrderMark,
      '{"type":"session","cwd":"/work/marked-mid-file"}\n',
      '"usage" but not JSON\n',
      '{"type":"session","cwd":"/work/last"}',
    );
    expect(sessions(bytes)).toEqual(["/work/caf\u00e9", "/work/\u65e5\u672c", "/work/last"]);
  });

  test("finds nothing in bytes with no marker", () => {
    expect(sessions(bytesOf('{"type":"note"}\n{"type":"note"}\n'))).toEqual([]);
  });
});
