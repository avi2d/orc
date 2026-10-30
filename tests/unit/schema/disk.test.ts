import { describe, expect, test } from "bun:test";
import { decodeDf } from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { issueOf, valueOf } from "../../lib/outcomes";

// The Used column leaves the container's other volumes out of both used and free.
describe("the disk reader on the Mac's data volume", () => {
  test("reads used as total less available bytes of the APFS container holding home, not the df Used column", () => {
    expect(valueOf(decodeDf(fixture("mac/df.txt")))).toEqual({
      usedBytes: (482797652 - 154758788) * 1024,
      totalBytes: 482797652 * 1024,
    });
  });
});

// The Used column leaves the root reservation out of both used and free.
describe("the disk reader on a WSL root", () => {
  test("reads used as total less available bytes of the root filesystem, not the df Used column", () => {
    expect(valueOf(decodeDf(fixture("linux/df.txt")))).toEqual({
      usedBytes: (1055762868 - 853496292) * 1024,
      totalBytes: 1055762868 * 1024,
    });
  });
});

describe("a df that answers nothing to count", () => {
  test("refuses empty output", () => {
    expect(issueOf(decodeDf(""))).toBe("df printed no filesystem line");
  });

  test("refuses a header with no filesystem under it", () => {
    expect(issueOf(decodeDf("Filesystem   1024-blocks      Used Available Capacity  Mounted on\n"))).toBe(
      "the df line does not read as filesystem, blocks, used, free, capacity and mount",
    );
  });
});
