import { describe, expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { DateTime, Effect } from "effect";
import { decodeSavedProfiles, decodeQuota, quotaBlocks } from "@tui-dash/schema";
import { blockDocument, type Block, frameText, quotaLines } from "@tui-dash/quota";
import { fixture } from "../../lib/fixtures";
import { quotaAxiRead } from "../../lib/quota-read";

// The frame time the pinned screen was recorded at, one second after the report.
const now = DateTime.makeUnsafe("2026-10-13T20:18:16Z");

const width = 84;

// Anthropic's clay for the Claude mark, and the dotfiles palette's primary and accent for Codex and OpenCode Go.
const brandColours = [
  ["\u25cf claude", [0xd9, 0x77, 0x57]],
  ["\u25cf codex", [0x60, 0xaa, 0xf3]],
  ["\u25cf opencode-go", [0x66, 0xcf, 0xe1]],
] as const;

const blocks = () => {
  const quota = decodeQuota(fixture("quota-axi/full.json"));
  const savedProfiles = decodeSavedProfiles(fixture("saved-profiles/status.json"));
  if (quota.kind !== "ok" || savedProfiles.kind !== "ok") throw new Error("the fixtures do not decode");
  return quotaBlocks(quotaAxiRead({ ...quota, capturedAt: now }), { ...savedProfiles, capturedAt: now }, now);
};

const normalize = (frame: string): string =>
  frame
    .split("\n")
    .map((row) => row.trimEnd())
    .join("\n")
    .trimEnd();

// The pinned screen comes from an earlier dashboard's quota panel for the same fixtures, not from this code.
const pinned = (): string => normalize(fixture("screens/quota-84x13.txt"));

const rendered = async (lines: Block) => {
  const setup = await createTestRenderer({ width, height: lines.length + 1 });
  const text = new TextRenderable(setup.renderer, { content: blockDocument(lines) });
  setup.renderer.root.add(text);
  await setup.renderOnce();
  return setup;
};

describe("the quota panel, against an earlier dashboard's pinned quota output", () => {
  test("renders the pinned frame through OpenTUI", async () => {
    const lines = quotaLines(blocks(), width, true, now);
    const setup = await rendered(lines);
    const frame = normalize(setup.captureCharFrame());
    await setup.dispose();
    expect(frame).toBe(pinned());
    expect(frame.split("\n")).toHaveLength(13);
  });

  test("the print path renders the same frame", async () => {
    const lines = quotaLines(blocks(), width, true, now);
    const frame = await Effect.runPromise(frameText(blockDocument(lines), width, lines.length + 1));
    expect(frame).toBe(pinned());
  });

  test("every provider header carries its brand colour, in bold", async () => {
    const lines = quotaLines(blocks(), width, true, now);
    const setup = await rendered(lines);
    const spans = setup.captureSpans();
    await setup.dispose();
    const headers = spans.lines.flatMap((line) => line.spans).filter((span) => span.text.startsWith("\u25cf"));
    for (const [name, rgb] of brandColours) {
      const found = headers.find((span) => span.text.startsWith(name));
      if (found?.fg === undefined) throw new Error("no header span for " + name);
      expect([found.fg.buffer[0], found.fg.buffer[1], found.fg.buffer[2]]).toEqual([...rgb]);
      expect(found.attributes).toBe(1);
    }
  });
});
